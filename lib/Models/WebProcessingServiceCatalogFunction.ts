import {
  action,
  computed,
  isObservableArray,
  observable,
  runInAction
} from "mobx";
import Mustache from "mustache";
import CesiumMath from "terriajs-cesium/Source/Core/Math";
import URI from "urijs";
import isDefined from "../Core/isDefined";
import loadWithXhr from "../Core/loadWithXhr";
import loadXML from "../Core/loadXML";
import runLater from "../Core/runLater";
import TerriaError from "../Core/TerriaError";
import Reproject from "../Map/Reproject";
import xml2json from "../ThirdParty/xml2json";
import { InfoSectionTraits } from "../Traits/CatalogMemberTraits";
import WebProcessingServiceCatalogFunctionTraits from "../Traits/WebProcessingServiceCatalogFunctionTraits";
import { ParameterTraits } from "../Traits/WebProcessingServiceCatalogItemTraits";
import CommonStrata from "./CommonStrata";
import CreateModel from "./CreateModel";
import createStratumInstance from "./createStratumInstance";
import DateTimeParameter from "./DateTimeParameter";
import EnumerationParameter from "./EnumerationParameter";
import FunctionParameter, {
  Options as FunctionParameterOptions
} from "./FunctionParameter";
import GeoJsonParameter from "./GeoJsonParameter";
import LineParameter from "./LineParameter";
import PointParameter from "./PointParameter";
import PolygonParameter from "./PolygonParameter";
import proxyCatalogItemUrl from "./proxyCatalogItemUrl";
import RectangleParameter from "./RectangleParameter";
import RegionParameter from "./RegionParameter";
import RegionTypeParameter from "./RegionTypeParameter";
import StringParameter from "./StringParameter";
import WebProcessingServiceCatalogItem from "./WebProcessingServiceCatalogItem";
import i18next from "i18next";
import CatalogFunctionMixin from "../ModelMixins/CatalogFunctionMixin";

const executeWpsTemplate = require("./ExecuteWpsTemplate.xml");

type AllowedValues = {
  Value?: string | string[];
};

type LiteralData = {
  AllowedValues?: AllowedValues;
  AllowedValue?: AllowedValues;
  AnyValue?: unknown;
};

type ComplexData = {
  Default?: { Format?: { Schema?: string } };
};

type BoundingBoxData = {
  Default?: { CRS?: string };
  Supported?: { CRS?: string[] };
};

type Input = {
  Identifier?: string;
  Name?: string;
  Abstract?: string;
  LiteralData?: LiteralData;
  ComplexData?: ComplexData;
  BoundingBoxData?: BoundingBoxData;
  minOccurs?: number;
};

type ProcessDescription = {
  DataInputs?: { Input: Input[] | Input };
  storeSupported?: string;
  statusSupported?: string;
};

export type WpsInputData = {
  inputValue: Promise<string | undefined> | string | undefined;
  inputType: string;
};

type ParameterConverter = {
  inputToParameter: (catalogFunction: CatalogFunctionMixin,
    input: Input,
    options: FunctionParameterOptions
  ) => FunctionParameter | undefined;

  parameterToInput: (parameter: FunctionParameter) => WpsInputData | undefined;
};

export default class WebProcessingServiceCatalogFunction extends CatalogFunctionMixin(
  CreateModel(WebProcessingServiceCatalogFunctionTraits)
) {
  static readonly type = "wps";
  readonly typeName = "Web Processing Service (WPS)";
  readonly proxyCacheDuration = "1d";

  readonly parameterConverters: ParameterConverter[] = [
    LiteralDataConverter,
    DateTimeConverter,
    PointConverter,
    LineConverter,
    PolygonConverter,
    RectangleConverter,
    GeoJsonGeometryConverter
  ];

  @observable
  private processDescription?: ProcessDescription;

  /**
   * Returns the proxied URL for the DescribeProcess endpoint.
   */
  @computed get describeProcessUrl() {
    if (!isDefined(this.url) || !isDefined(this.identifier)) {
      return;
    }

    const uri = new URI(this.url).query({
      service: "WPS",
      request: "DescribeProcess",
      version: "1.0.0",
      Identifier: this.identifier
    });

    return proxyCatalogItemUrl(this, uri.toString(), this.proxyCacheDuration);
  }

  /**
   * Returns the proxied URL for the Execute endpoint.
   */
  @computed get executeUrl() {
    if (!isDefined(this.url)) {
      return;
    }

    const uri = new URI(this.url).query({
      service: "WPS",
      request: "Execute",
      version: "1.0.0"
    });
    return proxyCatalogItemUrl(this, uri.toString(), this.proxyCacheDuration);
  }

  async forceLoadMetadata() {
    if (!isDefined(this.describeProcessUrl)) {
      return;
    }

    const xml = await this.getXml(this.describeProcessUrl);
    if (
      !isDefined(xml) ||
      !isDefined(xml.documentElement) ||
      xml.documentElement.localName !== "ProcessDescriptions"
    ) {
      throwInvalidWpsServerError(this, "DescribeProcess");
    }

    const json = xml2json(xml);
    if (!isDefined(json.ProcessDescription)) {
      throw new TerriaError({
        sender: this,
        title: i18next.t(
          "models.webProcessingService.processDescriptionErrorTitle"
        ),
        message: i18next.t(
          "models.webProcessingService.processDescriptionErrorMessage"
        )
      });
    }

    runInAction(() => {
      this.processDescription = json.ProcessDescription;
    });
  }

  /**
   * Indicates if the output can be stored by the WPS server and be accessed via a URL.
   */
  @computed get storeSupported() {
    return (
      isDefined(this.processDescription) &&
      this.processDescription.storeSupported === "true"
    );
  }

  /**
   * Indicates if Execute operation can return just the status information
   * and perform the actual operation asynchronously.
   */
  @computed get statusSupported() {
    return (
      isDefined(this.processDescription) &&
      this.processDescription.statusSupported === "true"
    );
  }

  /**
   * Return the inputs in the processDescription
   */
  @computed get inputs(): Input[] {
    if (!isDefined(this.processDescription)) {
      return [];
    }

    const dataInputs = this.processDescription.DataInputs;
    if (!isDefined(dataInputs) || !isDefined(dataInputs.Input)) {
      throw new TerriaError({
        sender: this,
        title: i18next.t("models.webProcessingService.processInputErrorTitle"),
        message: i18next.t(
          "models.webProcessingService.processInputErrorMessage"
        )
      });
    }

    const inputs =
      Array.isArray(dataInputs.Input) || isObservableArray(dataInputs.Input)
        ? dataInputs.Input
        : [dataInputs.Input];
    return inputs;
  }

  /**
   *  Maps the input to function parameters.
   *
   * We `keepAlive` because the parameter properties could be modified by
   * UI that can come and go, but we want those modifications to persist.
   */
  @computed({ keepAlive: true })
  get functionParameters() {
    const parameters = this.inputs.map(input => {
      const parameter = this.convertInputToParameter(this, input);
      if (isDefined(parameter)) {
        return parameter;
      }
      throw new TerriaError({
        sender: this,
        title: "Unsupported parameter type",
        message: `The parameter ${input.Identifier} is not a supported type of parameter.`
      });
    });
    return parameters;
  }

  /**
   * Performs the Execute request for the WPS process
   *
   * If `executeWithHttpGet` is true, a GET request is made
   * instead of the default POST request.
   */
  @action
  async invoke() {
    if (!isDefined(this.identifier) || !isDefined(this.executeUrl)) {
      return;
    }

    
  }

  /**
   * Handle the Execute response
   *
   * If execution succeeded, we create a WebProcessingServiceCatalogItem to show the result.
   * If execution failed, mark the pendingItem item as error.
   * Otherwise, if statusLocation is set, poll until we get a result or the pendingItem is removed from the workbench.
   */
  async handleExecuteResponse(
    xml: any,
    pendingItem: CatalogFunctionJob
  ): Promise<void> {
    if (
      !xml ||
      !xml.documentElement ||
      xml.documentElement.localName !== "ExecuteResponse"
    ) {
      throwInvalidWpsServerError(this, "ExecuteResponse");
    }
    const json = xml2json(xml);
    const status = json.Status;
    if (!isDefined(status)) {
      throw new TerriaError({
        sender: this,
        title: i18next.t(
          "models.webProcessingService.invalidResponseErrorTitle"
        ),
        message: i18next.t(
          "models.webProcessingService.invalidResponseErrorMessage",
          {
            name: this.name,
            email:
              '<a href="mailto:' +
              this.terria.supportEmail +
              '">' +
              this.terria.supportEmail +
              "</a>."
          }
        )
      });
    }

    if (isDefined(status.ProcessFailed)) {
      const e = status.ProcessFailed.ExceptionReport?.Exception;
      this.setErrorOnPendingItem(pendingItem, e?.ExceptionText || e?.Exception);
    } else if (isDefined(status.ProcessSucceeded)) {
      const item = await this.createCatalogItem(pendingItem, json);
      await item.loadMapItems();
      this.terria.workbench.add(item);
      this.terria.workbench.remove(pendingItem);
    } else if (
      isDefined(json.statusLocation) &&
      this.terria.workbench.contains(pendingItem)
    ) {
      return runLater(async () => {
        const promise = this.getXml(json.statusLocation);
        pendingItem.loadPromise = promise;
        const xml = await promise;
        return this.handleExecuteResponse(xml, pendingItem);
      }, 500) as Promise<void>;
    }
  }

  convertInputToParameter(catalogFunction:CatalogFunctionMixin, input: Input) {
    if (!isDefined(input.Identifier)) {
      return;
    }

    const isRequired = isDefined(input.minOccurs) && input.minOccurs > 0;

    for (let i = 0; i < this.parameterConverters.length; i++) {
      const converter = this.parameterConverters[i];
      const parameter = converter.inputToParameter(catalogFunction,input, {
        id: input.Identifier,
        name: input.Name,
        description: input.Abstract,
        isRequired,
        converter
      });
      if (isDefined(parameter)) {
        return parameter;
      }
    }
  }

  async convertParameterToInput(parameter: FunctionParameter) {
    let converter = <ParameterConverter>parameter.converter;
    const result = converter.parameterToInput(parameter);
    if (!isDefined(result)) {
      return;
    }

    const inputValue = await Promise.resolve(result.inputValue);
    if (!isDefined(inputValue)) {
      return;
    }

    return {
      inputIdentifier: parameter.id,
      inputValue: inputValue,
      inputType: result.inputType
    };
  }

  async createCatalogItem(
    pendingItem: CatalogFunctionJob,
    wpsResponse: any
  ) {
    const id = `result-${pendingItem.uniqueId}`;
    const item = new WebProcessingServiceCatalogItem(id, this.terria);
    const parameterTraits = await Promise.all(
      this.functionParameters.map(async p => {
        const geoJsonFeature = await runInAction(() => p.geoJsonFeature);
        const tmp = createStratumInstance(ParameterTraits, {
          name: p.name,
          value: p.formatValueAsString(),
          geoJsonFeature: <any>geoJsonFeature
        });
        return tmp;
      })
    );
    runInAction(() => {
      item.setTrait(CommonStrata.user, "name", pendingItem.name);
      item.setTrait(CommonStrata.user, "description", pendingItem.description);
      item.setTrait(CommonStrata.user, "wpsResponse", wpsResponse);
      item.setTrait(CommonStrata.user, "parameters", parameterTraits);
    });
    return item;
  }

  getXml(url: string, parameters?: any) {
    if (isDefined(parameters)) {
      url = new URI(url).query(parameters).toString();
    }
    return loadXML(url);
  }

  postXml(url: string, data: string) {
    return loadWithXhr({
      url: url,
      method: "POST",
      data,
      overrideMimeType: "text/xml",
      responseType: "document"
    });
  }
}

const LiteralDataConverter = {
  inputToParameter: function(catalogFunction:CatalogFunctionMixin,  input: Input, options: FunctionParameterOptions) {
    if (!isDefined(input.LiteralData)) {
      return;
    }

    const allowedValues =
      input.LiteralData.AllowedValues || input.LiteralData.AllowedValue;
    if (isDefined(allowedValues) && isDefined(allowedValues.Value)) {
      return new EnumerationParameter(catalogFunction, {
        ...options,
        possibleValues:
          Array.isArray(allowedValues.Value) ||
          isObservableArray(allowedValues.Value)
            ? allowedValues.Value
            : [allowedValues.Value]
      });
    } else if (isDefined(input.LiteralData.AnyValue)) {
      return new StringParameter(catalogFunction, {
        ...options
      });
    }
  },
  parameterToInput: function(parameter: FunctionParameter) {
    return {
      inputValue: <string | undefined>parameter.value,
      inputType: "LiteralData"
    };
  }
};

const DateTimeConverter = {
  inputToParameter: function(catalogFunction:CatalogFunctionMixin,input: Input, options: FunctionParameterOptions) {
    if (
      !isDefined(input.ComplexData) ||
      !isDefined(input.ComplexData.Default) ||
      !isDefined(input.ComplexData.Default.Format) ||
      !isDefined(input.ComplexData.Default.Format.Schema)
    ) {
      return undefined;
    }

    var schema = input.ComplexData.Default.Format.Schema;
    if (schema !== "http://www.w3.org/TR/xmlschema-2/#dateTime") {
      return undefined;
    }
    return new DateTimeParameter(catalogFunction, options);
  },
  parameterToInput: function(parameter: FunctionParameter) {
    return {
      inputType: "ComplexData",
      inputValue: DateTimeParameter.formatValueForUrl(parameter?.value?.toString() || '')
    };
  }
};

export const PointConverter = simpleGeoJsonDataConverter(
  "point",
  PointParameter
);
const LineConverter = simpleGeoJsonDataConverter("linestring", LineParameter);
const PolygonConverter = simpleGeoJsonDataConverter(
  "polygon",
  PolygonParameter
);

const RectangleConverter = {
  inputToParameter: function(catalogFunction: CatalogFunctionMixin, input: Input, options: FunctionParameterOptions) {
    if (
      !isDefined(input.BoundingBoxData) ||
      !isDefined(input.BoundingBoxData.Default) ||
      !isDefined(input.BoundingBoxData.Default.CRS)
    ) {
      return undefined;
    }
    var code = Reproject.crsStringToCode(input.BoundingBoxData.Default.CRS);
    var usedCrs = input.BoundingBoxData.Default.CRS;
    // Find out if Terria's CRS is supported.
    if (
      code !== Reproject.TERRIA_CRS &&
      isDefined(input.BoundingBoxData.Supported) &&
      isDefined(input.BoundingBoxData.Supported.CRS)
    ) {
      for (let i = 0; i < input.BoundingBoxData.Supported.CRS.length; i++) {
        if (
          Reproject.crsStringToCode(input.BoundingBoxData.Supported.CRS[i]) ===
          Reproject.TERRIA_CRS
        ) {
          code = Reproject.TERRIA_CRS;
          usedCrs = input.BoundingBoxData.Supported.CRS[i];
          break;
        }
      }
    }
    // We are currently only supporting Terria's CRS, because if we reproject we don't know the URI or whether
    // the bounding box order is lat-long or long-lat.
    if (!isDefined(code)) {
      return undefined;
    }

    return new RectangleParameter(catalogFunction, {
      ...options,
      crs: usedCrs
    });
  },
  parameterToInput: function(functionParameter: FunctionParameter) {
    const parameter = <RectangleParameter>functionParameter;
    const value = parameter.value;

    if (!isDefined(value)) {
      return;
    }

    let bboxMinCoord1, bboxMinCoord2, bboxMaxCoord1, bboxMaxCoord2, urn;
    // We only support CRS84 and EPSG:4326
    if (parameter.crs.indexOf("crs84") !== -1) {
      // CRS84 uses long, lat rather that lat, long order.
      bboxMinCoord1 = CesiumMath.toDegrees(value.west);
      bboxMinCoord2 = CesiumMath.toDegrees(value.south);
      bboxMaxCoord1 = CesiumMath.toDegrees(value.east);
      bboxMaxCoord2 = CesiumMath.toDegrees(value.north);
      // Comfortingly known as WGS 84 longitude-latitude according to Table 3 in OGC 07-092r1.
      urn = "urn:ogc:def:crs:OGC:1.3:CRS84";
    } else {
      // The URN value urn:ogc:def:crs:EPSG:6.6:4326 shall mean the Coordinate Reference System (CRS) with code
      // 4326 specified in version 6.6 of the EPSG database available at http://www.epsg.org/. That CRS specifies
      // the axis order as Latitude followed by Longitude.
      // We don't know about other URN versions, so are going to return 6.6 regardless of what was requested.
      bboxMinCoord1 = CesiumMath.toDegrees(value.south);
      bboxMinCoord2 = CesiumMath.toDegrees(value.west);
      bboxMaxCoord1 = CesiumMath.toDegrees(value.north);
      bboxMaxCoord2 = CesiumMath.toDegrees(value.east);
      urn = "urn:ogc:def:crs:EPSG:6.6:4326";
    }

    return {
      inputType: "BoundingBoxData",
      inputValue:
        bboxMinCoord1 +
        "," +
        bboxMinCoord2 +
        "," +
        bboxMaxCoord1 +
        "," +
        bboxMaxCoord2 +
        "," +
        urn
    };
  }
};

const GeoJsonGeometryConverter = {
  inputToParameter: function(catalogFunction: CatalogFunctionMixin, input: Input, options: FunctionParameterOptions) {
    if (
      !isDefined(input.ComplexData) ||
      !isDefined(input.ComplexData.Default) ||
      !isDefined(input.ComplexData.Default.Format) ||
      !isDefined(input.ComplexData.Default.Format.Schema)
    ) {
      return;
    }

    const schema = input.ComplexData.Default.Format.Schema;
    if (schema.indexOf("http://geojson.org/geojson-spec.html#") !== 0) {
      return undefined;
    }

    const regionTypeParameter = new RegionTypeParameter(catalogFunction, {
      id: "regionType",
      name: "Region Type",
      description: "The type of region to analyze.",
      converter: undefined
    });

    const regionParameter = new RegionParameter(catalogFunction,{
      id: "regionParameter",
      name: "Region Parameter",
      regionProvider: regionTypeParameter,
      converter: undefined
    });

    return new GeoJsonParameter(catalogFunction,{
      ...options,
      regionParameter
    });
  },

  parameterToInput: function(parameter: FunctionParameter): WpsInputData | undefined {
    if (!isDefined(parameter.value) || parameter.value === null) {
      return;
    }
    return (<GeoJsonParameter>parameter).getProcessedValue((<GeoJsonParameter>parameter).value);
  }
};

function simpleGeoJsonDataConverter(schemaType: string, klass: any) {
  return {
    inputToParameter: function(catalogFunction:CatalogFunctionMixin,
      input: Input,
      options: FunctionParameterOptions
    ) {
      if (
        !isDefined(input.ComplexData) ||
        !isDefined(input.ComplexData.Default) ||
        !isDefined(input.ComplexData.Default.Format) ||
        !isDefined(input.ComplexData.Default.Format.Schema)
      ) {
        return undefined;
      }

      var schema = input.ComplexData.Default.Format.Schema;
      if (schema.indexOf("http://geojson.org/geojson-spec.html#") !== 0) {
        return undefined;
      }

      if (schema.substring(schema.lastIndexOf("#") + 1) !== schemaType) {
        return undefined;
      }

      return new klass(catalogFunction, options);
    },
    parameterToInput: function(parameter: FunctionParameter) {
      return {
        inputType: "ComplexData",
        inputValue: klass.formatValueForUrl(parameter.value)
      };
    }
  };
}

function throwInvalidWpsServerError(
  wps: WebProcessingServiceCatalogFunction,
  endpoint: string
) {
  throw new TerriaError({
    title: i18next.t("models.webProcessingService.invalidWPSServerTitle"),
    message: i18next.t("models.webProcessingService.invalidWPSServerMessage", {
      name: wps.name,
      email:
        '<a href="mailto:' +
        wps.terria.supportEmail +
        '">' +
        wps.terria.supportEmail +
        "</a>.",
      endpoint
    })
  });
}

function htmlEscapeText(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

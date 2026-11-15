import { describe, expect, it } from "vitest";
import { API_HOST, DEFAULT_PORT, loadOptions } from "./options.ts";

const MQTT_URL = "mqtt://broker:1883";

describe("options", () => {
  describe("loadOptions", () => {
    describe("With no HEATMASTER_PORT", () => {
      it("port is 3000", () => {
        expect(DEFAULT_PORT).toBe(3000);
        expect(API_HOST).toBe("127.0.0.1");
        expect(loadOptions({ MQTT_URL }).port).toBe(3000);
      });
    });

    describe('With HEATMASTER_PORT "8123"', () => {
      it("port is 8123", () => {
        expect(loadOptions({ MQTT_URL, HEATMASTER_PORT: "8123" }).port).toBe(8123);
      });
    });

    describe('With HEATMASTER_PORT "abc", "0", "-1", "70000" or "80.5"', () => {
      it("throws an Error whose message names HEATMASTER_PORT", () => {
        for (const value of ["abc", "0", "-1", "70000", "80.5"]) {
          expect(() => loadOptions({ MQTT_URL, HEATMASTER_PORT: value }), value).toThrow(
            /HEATMASTER_PORT/,
          );
        }
      });
    });

    describe("With MQTT_URL=mqtt://broker:1883 and nothing else", () => {
      it("mqtt holds that url, no username, no password and no clientId", () => {
        expect(loadOptions({ MQTT_URL }).mqtt).toEqual({
          url: MQTT_URL,
          username: undefined,
          password: undefined,
          clientId: undefined,
        });
      });

      it('z2m.baseTopic is "zigbee2mqtt"', () => {
        expect(loadOptions({ MQTT_URL }).z2m).toEqual({ baseTopic: "zigbee2mqtt" });
      });
    });

    describe("With MQTT_USERNAME, MQTT_PASSWORD and Z2M_BASE_TOPIC=home/z2m", () => {
      it('mqtt holds both and z2m.baseTopic is "home/z2m"', () => {
        const options = loadOptions({
          MQTT_URL,
          MQTT_USERNAME: "heatmaster",
          MQTT_PASSWORD: "secret",
          Z2M_BASE_TOPIC: "home/z2m",
        });
        expect(options.mqtt.username).toBe("heatmaster");
        expect(options.mqtt.password).toBe("secret");
        expect(options.z2m.baseTopic).toBe("home/z2m");
      });
    });

    describe("With MQTT_URL missing or empty", () => {
      it("throws an Error whose message names MQTT_URL", () => {
        expect(() => loadOptions({})).toThrow(/MQTT_URL/);
        expect(() => loadOptions({ MQTT_URL: "" })).toThrow(/MQTT_URL/);
      });
    });

    describe("With an MQTT_URL that is not tcp or tls", () => {
      it("throws an Error whose message names MQTT_URL", () => {
        for (const url of [
          "ws://broker:9001",
          "wss://broker/mqtt",
          "http://broker",
          "broker:1883",
        ]) {
          expect(() => loadOptions({ MQTT_URL: url }), url).toThrow(/MQTT_URL/);
        }
      });

      it("mqtt:// and mqtts:// are accepted", () => {
        expect(loadOptions({ MQTT_URL: "mqtts://broker:8883" }).mqtt.url).toBe(
          "mqtts://broker:8883",
        );
      });
    });

    describe("With the optional variables set to an empty text", () => {
      it("they count as not set", () => {
        const options = loadOptions({
          MQTT_URL,
          MQTT_USERNAME: "",
          MQTT_PASSWORD: "",
          Z2M_BASE_TOPIC: "",
        });
        expect(options.mqtt.username).toBeUndefined();
        expect(options.mqtt.password).toBeUndefined();
        expect(options.z2m.baseTopic).toBe("zigbee2mqtt");
      });
    });

    describe("With HA_URL=http://supervisor/core and HA_TOKEN set", () => {
      it("ha holds both", () => {
        expect(
          loadOptions({ MQTT_URL, HA_URL: "http://supervisor/core", HA_TOKEN: "t0ken" }).ha,
        ).toEqual({ url: "http://supervisor/core", token: "t0ken" });
      });
    });

    describe("With neither HA_URL nor HA_TOKEN", () => {
      it("ha is undefined", () => {
        expect(loadOptions({ MQTT_URL }).ha).toBeUndefined();
        expect(loadOptions({ MQTT_URL, HA_URL: "", HA_TOKEN: "" }).ha).toBeUndefined();
      });
    });

    describe("With one of the two", () => {
      it("throws an Error whose message names the other", () => {
        expect(() => loadOptions({ MQTT_URL, HA_URL: "http://ha:8123" })).toThrow(/HA_TOKEN/);
        expect(() => loadOptions({ MQTT_URL, HA_TOKEN: "t0ken" })).toThrow(/HA_URL/);
      });
    });
  });
});

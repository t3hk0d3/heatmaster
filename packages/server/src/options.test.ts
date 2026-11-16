import { describe, expect, it } from "vitest";
import { API_HOST, DEFAULT_PORT, loadOptions, OptionsError, redactOptions } from "./options.ts";

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

    describe("With neither DATA_DIR nor PUBLIC_DIR", () => {
      it("dataDir is /data and publicDir is /config", () => {
        const options = loadOptions({ MQTT_URL });
        expect(options.dataDir).toBe("/data");
        expect(options.publicDir).toBe("/config");
      });
    });

    describe("With both set", () => {
      it("returns each value", () => {
        const options = loadOptions({ MQTT_URL, DATA_DIR: "/tmp/d", PUBLIC_DIR: "/tmp/p" });
        expect(options.dataDir).toBe("/tmp/d");
        expect(options.publicDir).toBe("/tmp/p");
      });
    });

    describe("With no DISCOVERY_PREFIX", () => {
      it('discoveryPrefix is "homeassistant"', () => {
        expect(loadOptions({ MQTT_URL }).discoveryPrefix).toBe("homeassistant");
      });
    });

    describe("With DISCOVERY_PREFIX=ha_test", () => {
      it('discoveryPrefix is "ha_test"', () => {
        expect(loadOptions({ MQTT_URL, DISCOVERY_PREFIX: "ha_test" }).discoveryPrefix).toBe(
          "ha_test",
        );
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

const codes = (env: Record<string, string | undefined>): Record<string, string[]> => {
  try {
    loadOptions(env);
  } catch (error) {
    expect(error).toBeInstanceOf(OptionsError);
    const found: Record<string, string[]> = {};
    for (const issue of (error as OptionsError).issues) {
      (found[issue.variable] ??= []).push(issue.code);
    }
    return found;
  }
  throw new Error("loadOptions did not throw");
};

describe("options (task 22)", () => {
  describe("loadOptions", () => {
    describe("With only MQTT_URL=mqtt://broker:1883", () => {
      it("returns that URL, no username, no Home Assistant link", () => {
        const options = loadOptions({ MQTT_URL });
        expect(options.mqtt.url).toBe(MQTT_URL);
        expect(options.mqtt.username).toBeUndefined();
        expect(options.ha).toBeUndefined();
      });
      it("dataDir is /data, publicDir is /config", () => {
        const options = loadOptions({ MQTT_URL });
        expect([options.dataDir, options.publicDir]).toEqual(["/data", "/config"]);
      });
      it("z2m.baseTopic is zigbee2mqtt, discoveryPrefix is homeassistant, port is 3000", () => {
        const options = loadOptions({ MQTT_URL });
        expect(options.z2m.baseTopic).toBe("zigbee2mqtt");
        expect(options.discoveryPrefix).toBe("homeassistant");
        expect(options.port).toBe(3000);
      });
    });

    describe("With every variable set", () => {
      it("returns each value", () => {
        const options = loadOptions({
          MQTT_URL: "mqtts://broker:8883",
          MQTT_USERNAME: "u",
          MQTT_PASSWORD: "p",
          HA_URL: "https://ha:8123",
          HA_TOKEN: "t",
          DATA_DIR: "/srv/d",
          PUBLIC_DIR: "/srv/p",
          Z2M_BASE_TOPIC: "home/z2m",
          DISCOVERY_PREFIX: "ha",
          HEATMASTER_PORT: "8123",
        });
        expect(options).toEqual({
          port: 8123,
          mqtt: { url: "mqtts://broker:8883", username: "u", password: "p", clientId: undefined },
          z2m: { baseTopic: "home/z2m" },
          ha: { url: "https://ha:8123", token: "t" },
          dataDir: "/srv/d",
          publicDir: "/srv/p",
          discoveryPrefix: "ha",
        });
      });
    });

    describe("With MQTT_URL missing", () => {
      it("throws OptionsError with code missing for MQTT_URL", () => {
        expect(codes({})).toEqual({ MQTT_URL: ["missing"] });
      });
    });

    describe("With MQTT_URL=http://broker or a text that is not a URL", () => {
      it("throws with code url_invalid", () => {
        for (const url of ["http://broker", "not a url", "mqtt://", "tcp://broker:1883"]) {
          expect(codes({ MQTT_URL: url }), url).toEqual({ MQTT_URL: ["url_invalid"] });
        }
      });
    });

    describe("With MQTT_URL=mqtt://user:secret@broker", () => {
      it("throws with code credentials_in_url", () => {
        expect(codes({ MQTT_URL: "mqtt://user:secret@broker" })).toEqual({
          MQTT_URL: ["credentials_in_url"],
        });
      });
      it('the message does not hold "secret"', () => {
        try {
          loadOptions({ MQTT_URL: "mqtt://user:secret@broker" });
        } catch (error) {
          expect((error as OptionsError).message).not.toContain("secret");
          for (const issue of (error as OptionsError).issues) {
            expect(issue.message).not.toContain("secret");
          }
          return;
        }
        throw new Error("loadOptions did not throw");
      });
    });

    describe("With MQTT_URL=mqtts://broker:8883", () => {
      it("is accepted", () => {
        expect(loadOptions({ MQTT_URL: "mqtts://broker:8883" }).mqtt.url).toBe(
          "mqtts://broker:8883",
        );
      });
    });

    describe("With MQTT_PASSWORD and no MQTT_USERNAME", () => {
      it("throws with code password_without_username", () => {
        expect(codes({ MQTT_URL, MQTT_PASSWORD: "p" })).toEqual({
          MQTT_PASSWORD: ["password_without_username"],
        });
      });
    });

    describe("With HA_URL and no HA_TOKEN, or the other way round", () => {
      it("throws with code pair_incomplete", () => {
        expect(codes({ MQTT_URL, HA_URL: "http://ha" })).toEqual({ HA_TOKEN: ["pair_incomplete"] });
        expect(codes({ MQTT_URL, HA_TOKEN: "t" })).toEqual({ HA_URL: ["pair_incomplete"] });
      });
    });

    describe("With HA_URL=http://supervisor/core and a token", () => {
      it("ha holds both", () => {
        expect(
          loadOptions({ MQTT_URL, HA_URL: "http://supervisor/core", HA_TOKEN: "t" }).ha,
        ).toEqual({ url: "http://supervisor/core", token: "t" });
      });
    });

    describe("With HA_URL=ws://x", () => {
      it("throws with code url_invalid", () => {
        expect(codes({ MQTT_URL, HA_URL: "ws://x", HA_TOKEN: "t" })).toEqual({
          HA_URL: ["url_invalid"],
        });
      });
    });

    describe("With DATA_DIR=data", () => {
      it("throws with code path_not_absolute", () => {
        expect(codes({ MQTT_URL, DATA_DIR: "data" })).toEqual({ DATA_DIR: ["path_not_absolute"] });
      });
    });

    describe("With PUBLIC_DIR equal to DATA_DIR", () => {
      it("throws with code same_directory", () => {
        expect(codes({ MQTT_URL, DATA_DIR: "/x", PUBLIC_DIR: "/x/" })).toEqual({
          PUBLIC_DIR: ["same_directory"],
        });
      });
    });

    describe('With Z2M_BASE_TOPIC of "a/#", "a b", "/a", "a/", or 129 characters', () => {
      it("throws with code topic_invalid", () => {
        for (const topic of ["a/#", "a b", "/a", "a/", "a+b", "a\u0001b", "x".repeat(129)]) {
          expect(codes({ MQTT_URL, Z2M_BASE_TOPIC: topic }), topic).toEqual({
            Z2M_BASE_TOPIC: ["topic_invalid"],
          });
        }
      });
    });

    describe("With Z2M_BASE_TOPIC=home/z2m", () => {
      it("is accepted", () => {
        expect(loadOptions({ MQTT_URL, Z2M_BASE_TOPIC: "home/z2m" }).z2m.baseTopic).toBe(
          "home/z2m",
        );
      });
    });

    describe("With DISCOVERY_PREFIX equal to Z2M_BASE_TOPIC, or either of them heatmaster", () => {
      it("throws with code topic_conflict", () => {
        for (const env of [
          { Z2M_BASE_TOPIC: "same", DISCOVERY_PREFIX: "same" },
          { Z2M_BASE_TOPIC: "heatmaster" },
          { DISCOVERY_PREFIX: "heatmaster" },
        ]) {
          const found = codes({ MQTT_URL, ...env });
          expect(Object.values(found).flat(), JSON.stringify(env)).toEqual(["topic_conflict"]);
        }
      });
    });

    describe('With HEATMASTER_PORT of "0", "65536", "80a" or "3000.5"', () => {
      it("throws with code port_invalid", () => {
        for (const port of ["0", "65536", "80a", "3000.5"]) {
          expect(codes({ MQTT_URL, HEATMASTER_PORT: port }), port).toEqual({
            HEATMASTER_PORT: ["port_invalid"],
          });
        }
      });
    });

    describe("With HEATMASTER_PORT=8123", () => {
      it("port is 8123", () => {
        expect(loadOptions({ MQTT_URL, HEATMASTER_PORT: "8123" }).port).toBe(8123);
      });
    });

    describe("With a variable set to an empty text", () => {
      it("it counts as not set", () => {
        const options = loadOptions({
          MQTT_URL,
          DATA_DIR: "",
          PUBLIC_DIR: "",
          DISCOVERY_PREFIX: "",
          HEATMASTER_PORT: "",
          HA_URL: "",
        });
        expect(options.dataDir).toBe("/data");
        expect(options.port).toBe(3000);
        expect(options.ha).toBeUndefined();
      });
    });

    describe("With three faults", () => {
      it("throws one OptionsError that lists all three", () => {
        const env = { MQTT_URL: "http://x", DATA_DIR: "d", HEATMASTER_PORT: "0" };
        expect(codes(env)).toEqual({
          MQTT_URL: ["url_invalid"],
          DATA_DIR: ["path_not_absolute"],
          HEATMASTER_PORT: ["port_invalid"],
        });
        expect(() => loadOptions(env)).toThrow(/MQTT_URL.*DATA_DIR.*HEATMASTER_PORT/);
      });
    });
  });

  describe("redactOptions", () => {
    describe("With a password and a token", () => {
      it('both are "***" and every other value is unchanged', () => {
        const options = loadOptions({
          MQTT_URL,
          MQTT_USERNAME: "u",
          MQTT_PASSWORD: "p4ss",
          HA_URL: "http://ha",
          HA_TOKEN: "t0ken",
        });
        const redacted = redactOptions(options);
        expect(redacted).toEqual({
          port: 3000,
          mqtt: { url: MQTT_URL, username: "u", password: "***" },
          z2m: { baseTopic: "zigbee2mqtt" },
          ha: { url: "http://ha", token: "***" },
          dataDir: "/data",
          publicDir: "/config",
          discoveryPrefix: "homeassistant",
        });
        expect(JSON.stringify(redacted)).not.toMatch(/p4ss|t0ken/);
      });
    });

    describe("With no password and no Home Assistant link", () => {
      it("neither appears", () => {
        const redacted = redactOptions(loadOptions({ MQTT_URL })) as Record<string, unknown>;
        expect(redacted).not.toHaveProperty("ha");
        expect(redacted.mqtt).not.toHaveProperty("password");
      });
    });
  });
});

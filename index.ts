import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { napcatPlugin } from "./src/channel.js";
import { handleNapCatMediaProxy, handleNapCatWebhook } from "./src/webhook.js";
import { setNapCatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "NapCatQQ",
  description: "QQ channel via NapCat (OneBot 11)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNapCatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin });

    api.registerHttpRoute({
      path: "/napcat",
      match: "exact",
      handler: handleNapCatWebhook,
      auth: "plugin",
    });
    api.registerHttpRoute({
      path: "/napcat/media",
      match: "exact",
      handler: handleNapCatMediaProxy,
      auth: "plugin",
    });
  },
};

export default plugin;

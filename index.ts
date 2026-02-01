import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { napcatPlugin } from "./src/channel.js";
import { handleNapCatWebhook } from "./src/webhook.js";
import { setNapCatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "NapCatQQ",
  description: "QQ channel via NapCat (OneBot 11)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNapCatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin as any });
    api.registerHttpHandler(handleNapCatWebhook);
  },
};

export default plugin;

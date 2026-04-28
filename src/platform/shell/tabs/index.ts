// Side-effect imports: registering built-in tab renderers.
import "./welcome";
import "./settings-placeholder";
import "./postgres-object-placeholder";

export { TabRegistry } from "./TabRegistry";
export { TabsProvider, useTabs } from "./TabsContext";
export { TabStrip } from "./TabStrip";
export { TabContent } from "./TabContent";
export { WELCOME_KIND } from "./welcome";
export { SETTINGS_PLACEHOLDER_KIND, SETTINGS_PLACEHOLDER_TAB_ID } from "./settings-placeholder";
export {
  POSTGRES_OBJECT_PLACEHOLDER_KIND,
  type PostgresObjectPlaceholderPayload,
} from "./postgres-object-placeholder";
export type { Tab } from "./types";

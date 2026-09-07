import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Verifier from "./Verifier.vue";
import EarlyAccess from "./EarlyAccess.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Verifier", Verifier);
    app.component("EarlyAccess", EarlyAccess);
  },
} satisfies Theme;

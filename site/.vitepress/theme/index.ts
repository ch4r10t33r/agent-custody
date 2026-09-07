import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Verifier from "./Verifier.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Verifier", Verifier);
  },
} satisfies Theme;

import tsParser from "@typescript-eslint/parser";
import vue from "eslint-plugin-vue";

export default [
  {
    ignores: [".nuxt/**", ".output/**", "node_modules/**", "src/**", "dist/**", "coverage/**", "prisma/generated/**"],
  },
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
  },
  {
    files: ["**/*.vue"],
    languageOptions: { parserOptions: { parser: tsParser } },
    rules: { "vue/multi-word-component-names": "off" },
  },
];

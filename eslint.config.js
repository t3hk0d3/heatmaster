import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { boundaryConfigs } from "./eslint.boundaries.js";

export default tseslint.config(
  globalIgnores(["**/node_modules/", "**/dist/", "**/coverage/", ".superpowers/"]),
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
  boundaryConfigs,
);

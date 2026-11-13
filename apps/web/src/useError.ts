import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "./api";

// An error as a sentence in the current language. The same function between renders (until the
// language changes), so it can sit in a hook's dependencies without re-running it on every render.
export function useErrorText() {
  const { t } = useTranslation();
  return useCallback(
    (e: unknown) => {
      const code = e instanceof ApiError ? e.code : "internal";
      const params = e instanceof ApiError ? e.params : {};
      return t(`errors.${code}`, { ...params, defaultValue: t("errors.internal") });
    },
    [t],
  );
}

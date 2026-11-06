import { useTranslation } from "react-i18next";
import { ApiError } from "./api";

// An error as a sentence in the current language.
export function useErrorText() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "internal";
    const params = e instanceof ApiError ? e.params : {};
    return t(`errors.${code}`, { ...params, defaultValue: t("errors.internal") });
  };
}

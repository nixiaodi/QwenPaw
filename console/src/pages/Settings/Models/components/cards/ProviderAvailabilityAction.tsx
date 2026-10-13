import { useState } from "react";
import { useTranslation } from "react-i18next";
import { providerApi } from "@/api/modules/provider";
import type { ProviderInfo } from "@/api/types";
import { useAppMessage } from "@/hooks/useAppMessage";
import styles from "../../index.module.less";

export function ProviderAvailabilityAction({
  provider,
  onSaved,
}: {
  provider: ProviderInfo;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const [busy, setBusy] = useState(false);
  const enabled = provider.enabled !== false;
  return (
    <button
      className={`${styles.groupCardActBtn} ${
        enabled ? styles.groupCardActBtnDanger : ""
      }`}
      disabled={busy}
      onClick={async (event) => {
        event.stopPropagation();
        if (busy) return;
        setBusy(true);
        try {
          await providerApi.configureProvider(provider.id, {
            enabled: !enabled,
          });
          onSaved();
        } catch (error) {
          message.error(
            error instanceof Error ? error.message : t("models.failedToSave"),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {t(enabled ? "common.disable" : "common.enable")}
    </button>
  );
}

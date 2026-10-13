import { useCallback, useMemo, useState } from "react";
import { Form } from "@agentscope-ai/design";
import { Button } from "antd";
import { useTranslation } from "react-i18next";
import api from "../../../api";
import { useAgentStore } from "../../../stores/agentStore";
import {
  ChannelCard,
  ChannelDrawer,
  useChannels,
  getChannelLabel,
  ChannelAvailableItem,
  type ChannelKey,
} from "./components";
import { PageHeader } from "@/components/PageHeader";
import { useAppMessage } from "../../../hooks/useAppMessage";
import styles from "./index.module.less";

function ChannelsPage() {
  const { t } = useTranslation();
  const { message, modal } = useAppMessage();
  const { selectedAgent } = useAgentStore();
  const {
    channels,
    orderedKeys,
    channelSchemas,
    isBuiltin,
    loading,
    fetchChannels,
  } = useChannels("user");
  const [saving, setSaving] = useState(false);
  const [activeKey, setActiveKey] = useState<ChannelKey | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [form] = Form.useForm<any>();

  // Sort cards: enabled first, then disabled (preserve orderedKeys order within each group)
  const { enabledCards, disabledCards } = useMemo(() => {
    const enabledCards: { key: ChannelKey; config: Record<string, unknown> }[] =
      [];
    const disabledCards: {
      key: ChannelKey;
      config: Record<string, unknown>;
    }[] = [];

    orderedKeys.forEach((key) => {
      const config = channels[key] || { enabled: false, bot_prefix: "" };
      if (config.enabled) {
        enabledCards.push({ key, config });
      } else {
        disabledCards.push({ key, config });
      }
    });

    return { enabledCards, disabledCards };
  }, [channels, orderedKeys]);

  const handleCardClick = useCallback(
    (key: ChannelKey) => {
      setActiveKey(key);
      setDrawerOpen(true);
      const channelConfig = channels[key] || { enabled: false, bot_prefix: "" };
      // Migrate legacy allowlist policy to new access control fields
      const accessControlDm =
        channelConfig.access_control_dm ||
        channelConfig.dm_policy === "allowlist";
      const accessControlGroup =
        channelConfig.access_control_group ||
        channelConfig.group_policy === "allowlist";
      form.setFieldsValue({
        ...channelConfig,
        access_control_dm: accessControlDm,
        access_control_group: accessControlGroup,
        show_tool_calls: channelConfig.show_tool_calls ?? true,
        show_tool_results: channelConfig.show_tool_results ?? true,
        tool_call_max_length: channelConfig.tool_call_max_length ?? 200,
        tool_result_max_length: channelConfig.tool_result_max_length ?? 500,
        show_thinking: channelConfig.show_thinking ?? true,
      });
    },
    [channels, form],
  );

  const handleDrawerClose = () => {
    setDrawerOpen(false);
    setActiveKey(null);
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!activeKey) return;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
      isBuiltin: _isBuiltin,
      bindingId: _bindingId,
      configuredSecretFields: _configuredSecretFields,
      display_name: bindingDisplayName,
      ...savedConfig
    } = channels[activeKey] || {};
    const updatedChannel: Record<string, unknown> = {
      ...savedConfig,
      ...values,
    };
    setSaving(true);
    try {
      if (updatedChannel.enabled === true) {
        const result = await api.checkUserChannelBindingConflict(
          selectedAgent,
          activeKey,
          updatedChannel,
        );
        if (result.conflict) {
          const shouldSave = await new Promise<boolean>((resolve) => {
            let settled = false;
            const settle = (value: boolean) => {
              if (settled) return;
              settled = true;
              resolve(value);
            };
            modal.confirm({
              centered: true,
              title: t("channels.botConflictTitle"),
              content: t("channels.personalBotConflictDescription"),
              okText: t("channels.botConflictConfirm"),
              okButtonProps: { danger: true },
              cancelText: t("common.cancel"),
              onOk: () => settle(true),
              onCancel: () => settle(false),
              afterClose: () => settle(false),
            });
          });
          if (!shouldSave) return;
        }
      }
      await api.updateUserChannelBinding(selectedAgent, activeKey, {
        display_name:
          typeof bindingDisplayName === "string" && bindingDisplayName
            ? bindingDisplayName
            : activeLabel,
        enabled: updatedChannel.enabled === true,
        config: updatedChannel,
      });
      await fetchChannels();
      setDrawerOpen(false);
      message.success(t("channels.bindingSaved"));
    } catch (error) {
      console.error("Failed to update channel config:", error);
      message.error(t("channels.configFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteBinding = async () => {
    if (!activeKey) return;
    setSaving(true);
    try {
      await api.deleteUserChannelBinding(selectedAgent, activeKey);
      await fetchChannels();
      handleDrawerClose();
      message.success(t("channels.bindingDeleted"));
    } catch (error) {
      console.error("Failed to delete user channel binding:", error);
      message.error(t("channels.bindingDeleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  const activeLabel = activeKey ? getChannelLabel(activeKey, t) : "";

  return (
    <div className={styles.channelsPage}>
      <PageHeader
        className={styles.pageHeader}
        items={[{ title: t("nav.control") }, { title: t("channels.title") }]}
        center={
          <div className={styles.headerControls}>
            <div className={styles.viewTabs}>
              <span className={`${styles.filterTab} ${styles.filterTabActive}`}>
                {t("channels.myBindings")}
              </span>
            </div>
          </div>
        }
      />
      <div className={styles.channelsContainer}>
        {loading ? (
          <div className={styles.loading}>
            <span className={styles.loadingText}>{t("channels.loading")}</span>
          </div>
        ) : (
          <>
            {/* Enabled Channels Section */}
            <div className={styles.panelSection}>
              <div className={styles.panelTitle}>
                <span className={styles.panelDotGreen} />
                {t("channels.enabledSection")}
                <span className={styles.panelCount}>
                  {t("channels.enabledCount", { count: enabledCards.length })}
                </span>
              </div>

              {enabledCards.length > 0 ? (
                <div className={styles.channelsGrid}>
                  {enabledCards.map(({ key, config }) => (
                    <ChannelCard
                      key={key}
                      channelKey={key}
                      config={config}
                      iconUrl={channelSchemas[key]?.icon}
                      onClick={() => handleCardClick(key)}
                    />
                  ))}
                </div>
              ) : (
                <div className={styles.emptyConfigured}>
                  <p>{t("channels.noEnabledChannels")}</p>
                  {disabledCards.length > 0 && (
                    <Button
                      type="primary"
                      onClick={() => {
                        document
                          .getElementById("available-channels")
                          ?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      {t("channels.goEnableChannels")}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Available Channels Section */}
            {disabledCards.length > 0 && (
              <div
                id="available-channels"
                className={styles.panelSectionDashed}
              >
                <div className={styles.panelTitle}>
                  <span className={styles.panelDotGray} />
                  {t("channels.availableSection")}
                </div>
                <div className={styles.availableGrid}>
                  {disabledCards.map(({ key }) => (
                    <ChannelAvailableItem
                      key={key}
                      channelKey={key}
                      iconUrl={channelSchemas[key]?.icon}
                      onClick={() => handleCardClick(key)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <ChannelDrawer
        open={drawerOpen}
        activeKey={activeKey}
        activeLabel={activeLabel}
        form={form}
        saving={saving}
        initialValues={activeKey ? channels[activeKey] : undefined}
        isBuiltin={activeKey ? isBuiltin(activeKey) : true}
        channelSchema={activeKey ? channelSchemas[activeKey] : undefined}
        onClose={handleDrawerClose}
        onSubmit={handleSubmit}
        canDelete={Boolean(channels[activeKey || ""]?.bindingId)}
        onDelete={handleDeleteBinding}
      />
    </div>
  );
}

export default ChannelsPage;

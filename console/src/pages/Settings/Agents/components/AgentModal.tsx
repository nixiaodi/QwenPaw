import { useEffect, useState, useMemo } from "react";
import {
  Modal,
  Alert,
  Form,
  Input,
  Button,
  Select,
  Radio,
  Space,
  Switch,
  Typography,
  Empty,
  Spin,
} from "antd";
import { CheckOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { AgentSummary } from "@/api/types/agents";
import type { ModelSlotConfig } from "@/api/types/provider";
import { getAgentDisplayName } from "@/utils/agentDisplayName";
import type { SkillCatalogItem } from "@/api/types/skillGovernance";
import { createSkillGovernanceApi } from "@/api/modules/skillGovernance";
import { useSkillScope } from "@/api/skillScope";
import { skillErrorMessage } from "@/pages/Agent/Skills/useSkillRuntime";
import { createSkillApi } from "@/api/modules/skill";
import { modelCatalogApi } from "@/api/modules/modelCatalog";
import { providerIcon } from "../../Models/components/providerIcon";
import styles from "../index.module.less";
import { AgentBackendFields } from "./AgentBackendFields";
import {
  MAIL_DOMAIN_PICKER_DOMAINS,
  MAIL_DOMAIN_WHITELIST,
  MAIL_ENTERPRISE_SERVICE_DOMAINS,
} from "./mailDomains";

const { Text } = Typography;

const MAIL_DOMAIN_OPTIONS = MAIL_DOMAIN_PICKER_DOMAINS.map((domain) => ({
  value: domain,
  label: domain,
}));

// Domains whose credential is a 16-char authorization code.
const MAIL_AUTH_CODE_DOMAINS = [
  "163.com",
  "126.com",
  "yeah.net",
  "qq.com",
  "foxmail.com",
  "sina.com",
  "sina.cn",
  "gmail.com",
];

const MAIL_PROVIDER_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: "tencent_exmail", labelKey: "agent.mailProviderTencentExmail" },
  { value: "aliyun_qiye", labelKey: "agent.mailProviderAliyunQiye" },
  { value: "netease_qiye", labelKey: "agent.mailProviderNeteaseQiye" },
];

const MAIL_DOMAIN_PATTERN =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

const MAIL_PUSH_MODE_DESC_KEYS: Record<string, string> = {
  off: "agent.mailPushModeOffDesc",
  rules_only: "agent.mailPushModeRulesOnlyDesc",
  rules_then_agent: "agent.mailPushModeRulesThenAgentDesc",
  agent_all: "agent.mailPushModeAgentAllDesc",
};

// 0.2.0: rule-based modes are hidden from the UI but kept on the backend.
// A legacy value is only shown (read-only choice) while it is the current one.
const LEGACY_MAIL_PUSH_MODE_LABEL_KEYS: Record<string, string> = {
  rules_only: "agent.mailPushModeRulesOnly",
  rules_then_agent: "agent.mailPushModeRulesThenAgent",
};

interface EligibleProvider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

interface AgentModalProps {
  open: boolean;
  editingAgent: AgentSummary | null;
  form: ReturnType<typeof Form.useForm>[0];
  selectedSkills: string[];
  onSelectedSkillsChange: (skills: string[]) => void;
  onInstalledSkillsLoaded: (skills: string[]) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  governanceMode?: boolean;
}

interface AgentModelFormValues {
  backend?: string;
  active_model_provider?: string;
  active_model_model?: string;
}

export function toAgentActiveModel(
  values: AgentModelFormValues,
): ModelSlotConfig | null {
  if (
    values.backend === "qwenpaw" &&
    values.active_model_provider &&
    values.active_model_model
  ) {
    return {
      provider_id: values.active_model_provider,
      model: values.active_model_model,
    };
  }
  return null;
}

export function AgentModal(props: AgentModalProps) {
  const scope = useSkillScope(props.editingAgent?.id);
  return <AgentModalBody key={`${scope.key}:${props.open}`} {...props} />;
}

function AgentModalBody({
  open,
  editingAgent,
  form,
  selectedSkills,
  onSelectedSkillsChange,
  onInstalledSkillsLoaded,
  onSave,
  onCancel,
  governanceMode = false,
}: AgentModalProps) {
  const { t } = useTranslation();
  const scope = useSkillScope(editingAgent?.id);
  const governance = useMemo(() => createSkillGovernanceApi(scope), [scope]);
  const skillApi = useMemo(() => createSkillApi(scope), [scope]);
  const [skillError, setSkillError] = useState("");
  const [poolSkills, setPoolSkills] = useState<Array<Pick<SkillCatalogItem, "name">>>([]);
  const [installedSkills, setInstalledSkills] = useState<string[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [providers, setProviders] = useState<EligibleProvider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [globalActiveModel, setGlobalActiveModel] =
    useState<ModelSlotConfig | null>(null);

  const selectedProviderId = Form.useWatch("active_model_provider", form);
  const selectedModelId = Form.useWatch("active_model_model", form);
  const mailMode = Form.useWatch("mail_mode", form);
  const mailPushMode = Form.useWatch(["mail_push", "mode"], form);
  const mailDomain = Form.useWatch(["mail_credential", "domain"], form);
  const mailCredential = Form.useWatch(["mail_credential", "auth_code"], form);
  const selectedBackend = Form.useWatch("backend", form) ?? "qwenpaw";
  const modelReadOnly = Boolean(
    editingAgent && editingAgent.can_edit === false && !governanceMode,
  );

  const isCustomMailDomain =
    !!mailDomain && !MAIL_DOMAIN_WHITELIST.includes(mailDomain);

  // Whitelisted domains must submit an empty provider.
  useEffect(() => {
    if (
      !isCustomMailDomain &&
      form.getFieldValue(["mail_credential", "provider"])
    ) {
      form.setFieldValue(["mail_credential", "provider"], "");
    }
  }, [isCustomMailDomain, form]);

  const isAuthCodeDomain = MAIL_AUTH_CODE_DOMAINS.includes(mailDomain ?? "");
  const mailCredentialHintKey = useMemo(() => {
    if (
      isCustomMailDomain ||
      MAIL_ENTERPRISE_SERVICE_DOMAINS.includes(mailDomain ?? "")
    ) {
      return "agent.mailCredentialHintEnterprise";
    }
    if (mailDomain === "gmail.com") return "agent.mailCredentialHintGmail";
    if (mailDomain === "aliyun.com") return "agent.mailCredentialHintAliyun";
    return "agent.mailCredentialHintAuthCode";
  }, [mailDomain, isCustomMailDomain]);

  const eligibleProviders: EligibleProvider[] = useMemo(() => {
    return providers;
  }, [providers]);

  const availableModels = useMemo(() => {
    if (!selectedProviderId) return [];
    const provider = eligibleProviders.find((p) => p.id === selectedProviderId);
    return provider?.models ?? [];
  }, [selectedProviderId, eligibleProviders]);

  useEffect(() => {
    if (!open || selectedBackend !== "qwenpaw") return;
    let active = true;

    setLoadingProviders(true);
    Promise.allSettled([
      modelCatalogApi.list(editingAgent?.id),
      modelCatalogApi.default(),
    ])
      .then(([data, activeModel]) => {
        if (!active || !scope.current()) return;
        const grouped = new Map<string, EligibleProvider>();
        const models = data.status === "fulfilled" ? data.value.models : [];
        models.forEach((model) => {
          const provider = grouped.get(model.provider_id) ?? {
            id: model.provider_id,
            name: model.provider_name,
            models: [],
          };
          provider.models.push({ id: model.model, name: model.name });
          grouped.set(provider.id, provider);
        });
        setProviders([...grouped.values()]);
        setGlobalActiveModel(
          activeModel.status === "fulfilled"
            ? activeModel.value.active_llm ?? null
            : null,
        );
      })
      .catch((err) => console.error("Failed to load providers:", err))
      .finally(() => {
        if (active && scope.current()) setLoadingProviders(false);
      });

    setPoolSkills([]);
    setInstalledSkills([]);
    setSkillError("");
    onSelectedSkillsChange([]);
    onInstalledSkillsLoaded([]);
    if (!governanceMode && (scope.multiUser ? editingAgent && scope.canEdit : scope.ready && (!editingAgent || scope.canEdit))) {
      setLoadingSkills(true);
      void Promise.all([
        scope.multiUser ? governance.catalog() : skillApi.listSkillPoolSkills().then(items => ({ items })),
        editingAgent ? skillApi.listSkills(editingAgent.id) : Promise.resolve([]),
      ])
        .then(([catalog, workspaceSkills]) => {
          if (!active || !scope.current()) return;
          const names = new Set(catalog.items.map((skill) => skill.name));
          const installed = workspaceSkills
            .filter((skill) => names.has(skill.name))
            .map((skill) => skill.name);
          setPoolSkills(catalog.items);
          setInstalledSkills(installed);
          onInstalledSkillsLoaded(installed);
          onSelectedSkillsChange(installed);
        })
        .catch((error) => {
          if (active && scope.current())
            setSkillError(skillErrorMessage(error, t));
        })
        .finally(() => {
          if (active && scope.current()) setLoadingSkills(false);
        });
    } else {
      setLoadingSkills(false);
    }
    return () => {
      active = false;
    };
  }, [
    editingAgent,
    onInstalledSkillsLoaded,
    onSelectedSkillsChange,
    open,
    selectedBackend,
    governanceMode,
    scope,
    governance,
    skillApi,
    t,
  ]);

  const handleProviderChange = (providerId: string) => {
    form.setFieldsValue({
      active_model_provider: providerId,
      active_model_model: undefined,
    });
  };

  const handleClearModel = () => {
    form.setFieldsValue({
      active_model_provider: undefined,
      active_model_model: undefined,
    });
  };

  const toggleSkill = (name: string) => {
    if (!scope.current() || (scope.multiUser || editingAgent ? !scope.canEdit : !scope.ready)) return;
    const isInstalled = editingAgent && installedSkills.includes(name);
    if (isInstalled) return;

    if (selectedSkills.includes(name)) {
      onSelectedSkillsChange(selectedSkills.filter((s) => s !== name));
    } else {
      onSelectedSkillsChange([...selectedSkills, name]);
    }
  };

  const handleSelectAll = () => {
    const allNames = poolSkills.map((s) => s.name);
    onSelectedSkillsChange(allNames);
  };

  const handleSelectNone = () => {
    onSelectedSkillsChange(editingAgent ? [...installedSkills] : []);
  };

  return (
    <Modal
      title={
        editingAgent
          ? t("agent.editTitle", {
              name: getAgentDisplayName(editingAgent, t),
            })
          : t("agent.createTitle")
      }
      open={open}
      onOk={onSave}
      onCancel={onCancel}
      width={760}
      styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
    >
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item name="active_model_provider" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="active_model_model" hidden>
          <Input />
        </Form.Item>

        <AgentBackendFields form={form} open={open} />

        {editingAgent && (
          <Form.Item name="id" label={t("agent.id")}>
            <Input disabled />
          </Form.Item>
        )}
        {!editingAgent && (
          <Form.Item
            name="id"
            label={t("agent.idLabel")}
            help={t("agent.idHelp")}
            rules={[
              {
                pattern: /^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$/,
                message: t("agent.idPattern"),
              },
            ]}
          >
            <Input placeholder={t("agent.idPlaceholder")} />
          </Form.Item>
        )}
        <Form.Item
          name="name"
          label={t("agent.name")}
          rules={[{ required: true, message: t("agent.nameRequired") }]}
        >
          <Input placeholder={t("agent.namePlaceholder")} />
        </Form.Item>
        <Form.Item name="description" label={t("agent.description")}>
          <Input.TextArea
            placeholder={t("agent.descriptionPlaceholder")}
            rows={3}
          />
        </Form.Item>
        <Form.Item
          hidden={selectedBackend !== "qwenpaw"}
          label={t("agent.model")}
          help={
            selectedProviderId && selectedModelId
              ? t("agent.modelExplicit")
              : globalActiveModel
              ? t("agent.modelInheritCurrent", {
                  model: `${globalActiveModel.provider_id}/${globalActiveModel.model}`,
                })
              : t("agent.modelInheritUnavailable")
          }
        >
          <Space.Compact style={{ width: "100%" }}>
            <Select
              value={selectedProviderId || undefined}
              onChange={handleProviderChange}
              placeholder={t("agent.modelPlaceholder")}
              allowClear
              onClear={handleClearModel}
              disabled={modelReadOnly}
              loading={loadingProviders}
              style={{ width: "45%", gap: "8px" }}
              showSearch
              optionFilterProp="label"
              options={eligibleProviders.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              optionRender={({ value }) => {
                const p = eligibleProviders.find((ep) => ep.id === value);
                if (!p) return value;
                return (
                  <Space size={6}>
                    <img
                      src={providerIcon(p.id)}
                      alt=""
                      style={{ width: 16, height: 16 }}
                    />
                    <span>{p.name}</span>
                  </Space>
                );
              }}
              notFoundContent={
                loadingProviders ? (
                  <Spin size="small" />
                ) : (
                  t("agent.noConfiguredModels")
                )
              }
            />
            <Select
              value={selectedModelId || undefined}
              onChange={(modelId) =>
                form.setFieldsValue({ active_model_model: modelId })
              }
              placeholder={
                selectedProviderId
                  ? t("models.model")
                  : t("agent.modelPlaceholder")
              }
              disabled={!selectedProviderId || modelReadOnly}
              style={{ width: "55%" }}
              showSearch
              optionFilterProp="label"
              options={availableModels.map((m) => ({
                value: m.id,
                label: m.name || m.id,
              }))}
            />
          </Space.Compact>
        </Form.Item>
        <Form.Item
          name="workspace_dir"
          label={t("agent.workspace")}
          help={!editingAgent ? t("agent.workspaceHelp") : undefined}
        >
          <Input
            placeholder="~/.qwenpaw/workspaces/my-agent"
            disabled={!!editingAgent}
          />
        </Form.Item>
        <Form.Item
          name="mail_mode"
          label={t("agent.mailManagement")}
          initialValue="none"
          hidden={selectedBackend !== "qwenpaw"}
        >
          <Radio.Group>
            <Radio value="none">{t("agent.mailModeNone")}</Radio>
            <Radio value="personal">{t("agent.mailModePersonal")}</Radio>
            <Radio value="dedicated">{t("agent.mailModeDedicated")}</Radio>
          </Radio.Group>
        </Form.Item>
        {selectedBackend === "qwenpaw" && mailMode === "personal" && (
          <>
            <Form.Item
              name={["mail_credential", "name"]}
              label={t("agent.mailName")}
              rules={[{ required: true, message: t("agent.mailNameRequired") }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name={["mail_credential", "domain"]}
              label={t("agent.mailDomain")}
              initialValue="163.com"
              rules={[
                { required: true, message: t("agent.mailDomainRequired") },
                {
                  pattern: MAIL_DOMAIN_PATTERN,
                  message: t("agent.mailDomainInvalid"),
                },
              ]}
            >
              <Select
                options={MAIL_DOMAIN_OPTIONS}
                placeholder={t("agent.mailDomainPlaceholder")}
              />
            </Form.Item>
            {isCustomMailDomain && (
              <Form.Item
                name={["mail_credential", "provider"]}
                label={t("agent.mailProvider")}
                rules={[
                  { required: true, message: t("agent.mailProviderRequired") },
                ]}
              >
                <Select
                  placeholder={t("agent.mailProviderPlaceholder")}
                  options={MAIL_PROVIDER_OPTIONS.map(({ value, labelKey }) => ({
                    value,
                    label: t(labelKey),
                  }))}
                />
              </Form.Item>
            )}
            <Form.Item
              name={["mail_credential", "auth_code"]}
              label={
                isAuthCodeDomain
                  ? t("agent.mailAuthCode")
                  : t("agent.mailCredentialLabel")
              }
              extra={t(mailCredentialHintKey)}
              rules={[
                {
                  required: !editingAgent,
                  message: isAuthCodeDomain
                    ? t("agent.mailAuthCodeRequired")
                    : t("agent.mailCredentialRequired"),
                },
                ...(isAuthCodeDomain
                  ? [{ len: 16, message: t("agent.mailAuthCodeLength") }]
                  : []),
              ]}
            >
              <Input.Password placeholder={t(mailCredentialHintKey)} />
            </Form.Item>
          </>
        )}
        {selectedBackend === "qwenpaw" && mailMode === "dedicated" && (
          <>
            <Form.Item
              name={["mail_credential", "name"]}
              label={t("agent.mailNameDedicated")}
              rules={[
                {
                  required: !!mailCredential,
                  message: t("agent.mailNameRequired"),
                },
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name={["mail_credential", "domain"]}
              label={t("agent.mailDomain")}
              initialValue="163.com"
              rules={[
                { required: true, message: t("agent.mailDomainRequired") },
                {
                  pattern: MAIL_DOMAIN_PATTERN,
                  message: t("agent.mailDomainInvalid"),
                },
              ]}
            >
              <Select
                options={MAIL_DOMAIN_OPTIONS}
                placeholder={t("agent.mailDomainPlaceholder")}
              />
            </Form.Item>
            {isCustomMailDomain && (
              <Form.Item
                name={["mail_credential", "provider"]}
                label={t("agent.mailProvider")}
                rules={[
                  { required: true, message: t("agent.mailProviderRequired") },
                ]}
              >
                <Select
                  placeholder={t("agent.mailProviderPlaceholder")}
                  options={MAIL_PROVIDER_OPTIONS.map(({ value, labelKey }) => ({
                    value,
                    label: t(labelKey),
                  }))}
                />
              </Form.Item>
            )}
            <Form.Item
              name={["mail_credential", "auth_code"]}
              label={
                isAuthCodeDomain
                  ? t("agent.mailAuthCodeOptional")
                  : t("agent.mailCredentialOptional")
              }
              extra={t("agent.mailDedicatedCredentialHint", {
                credentialHint: t(mailCredentialHintKey),
              })}
              rules={[
                ...(isAuthCodeDomain
                  ? [{ len: 16, message: t("agent.mailAuthCodeLength") }]
                  : []),
              ]}
            >
              <Input.Password placeholder={t(mailCredentialHintKey)} />
            </Form.Item>
          </>
        )}
        {selectedBackend === "qwenpaw" && mailMode && mailMode !== "none" && (
          <Form.Item
            name={["mail_push", "mode"]}
            label={t("agent.mailPushTitle")}
            initialValue="off"
            extra={t(MAIL_PUSH_MODE_DESC_KEYS[mailPushMode || "off"])}
          >
            <Select
              options={[
                { value: "off", label: t("agent.mailPushModeOff") },
                {
                  value: "agent_all",
                  label: t("agent.mailPushModeAgentAll"),
                },
                // Keep the legacy value selectable only while it is the
                // current one, so old configs don't show a bare value.
                // Once the user switches away it can't be selected back.
                ...(mailPushMode &&
                LEGACY_MAIL_PUSH_MODE_LABEL_KEYS[mailPushMode]
                  ? [
                      {
                        value: mailPushMode,
                        label: `${t(
                          LEGACY_MAIL_PUSH_MODE_LABEL_KEYS[mailPushMode],
                        )}${t("agent.mailPushModeLegacySuffix")}`,
                      },
                    ]
                  : []),
              ]}
            />
          </Form.Item>
        )}
        {selectedBackend === "qwenpaw" &&
          mailMode &&
          mailMode !== "none" &&
          mailPushMode &&
          mailPushMode !== "off" && (
            <Form.Item
              label={t("agent.mailAccessControl")}
              name={["mail_push", "access_control_enabled"]}
              valuePropName="checked"
              initialValue={false}
              extra={t("agent.mailAccessControlTip")}
            >
              <Switch />
            </Form.Item>
          )}
      </Form>

      <div
        style={{
          marginTop: 4,
          display:
            selectedBackend === "qwenpaw" && !governanceMode
              ? undefined
              : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <Text type="secondary" style={{ fontSize: 13 }}>
            {editingAgent
              ? t("agent.addSkillsToAgent")
              : t("agent.initialSkills")}
          </Text>
          <Space size={4}>
            <Button size="small" type="primary" onClick={handleSelectAll}>
              {t("agent.selectAll")}
            </Button>
            <Button size="small" type="default" onClick={handleSelectNone}>
              {t("agent.selectNone")}
            </Button>
          </Space>
        </div>

        {skillError && <Alert type="error" message={skillError} />}
        {loadingSkills ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <Spin size="small" />
          </div>
        ) : poolSkills.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              editingAgent
                ? t("skillGovernance.emptyCatalog")
                : t("skillGovernance.createFirst")
            }
          />
        ) : (
          <div className={styles.pickerGrid}>
            {poolSkills.map((skill) => {
              const selected = selectedSkills.includes(skill.name);
              const isInstalled =
                !!editingAgent && installedSkills.includes(skill.name);
              return (
                <div
                  key={skill.name}
                  className={`${styles.pickerCard} ${
                    selected ? styles.pickerCardSelected : ""
                  } ${isInstalled ? styles.pickerCardDisabled : ""}`}
                  onClick={() => toggleSkill(skill.name)}
                >
                  {selected && (
                    <span className={styles.pickerCheck}>
                      <CheckOutlined />
                    </span>
                  )}
                  <div className={styles.pickerCardTitle}>{skill.name}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

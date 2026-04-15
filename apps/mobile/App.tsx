import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { getApiUrl } from "./src/config";
import {
  getWebBrowserCallbackUrl,
  logOAuth,
  parseAuthRedirect,
  redactUrlForLog,
  summarizeAuthSessionResult,
  waitForOAuthDeepLink,
} from "./src/oauthRedirect";
import * as api from "./src/api";
import {
  initNotificationHandler,
  registerExpoPushWithApi,
  shouldSkipExpoNotificationsModule,
  subscribeMailNotifications,
} from "./src/notificationService";

WebBrowser.maybeCompleteAuthSession();

const TOKEN_KEY = "nevermiss_session";
/** While Important is open, ask the server to sync Gmail then refetch captures */
const FEED_SYNC_POLL_MS = 12_000;
/** Other tabs: light refetch only (no Gmail pull) */
const IDLE_TAB_POLL_MS = 45_000;

type Tab = "feed" | "rules" | "settings";

function ruleTypeLabel(t: api.Rule["type"]): string {
  if (t === "sender_email") return "Sender";
  if (t === "domain") return "Domain";
  return "Gmail label";
}

function formatConnectError(code: string): string {
  const key = decodeURIComponent(code).replace(/\+/g, " ");
  if (
    key.includes("Gmail API") &&
    (key.includes("disabled") || key.includes("has not been used"))
  ) {
    return "Enable the Gmail API in Google Cloud: APIs & Services → Library → search “Gmail API” → Enable. Wait a minute, then try Connect again.";
  }
  const hints: Record<string, string> = {
    google_access_denied:
      "Sign-in was cancelled. Your inbox was not connected.",
    missing_refresh_reauthorize:
      "Google didn’t issue a fresh connection. In Google Account → Security → Third-party apps with account access, remove this app if it’s listed, then connect again.",
    missing_code_or_state:
      "The sign-in page didn’t finish loading correctly. Try again.",
    invalid_state: "That sign-in link expired. Tap Connect again.",
  };
  if (key.startsWith("google_")) {
    if (key === "google_access_denied") return hints.google_access_denied;
    const rest = key.replace(/^google_/, "").replace(/_/g, " ");
    return `Google couldn’t finish sign-in (${rest}). Try again.`;
  }
  return (
    hints[key] ??
    `Could not connect your email (${key}). Check your network and try again.`
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("feed");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<api.Me | null>(null);
  const [rules, setRules] = useState<api.Rule[]>([]);
  const [captures, setCaptures] = useState<api.Capture[]>([]);
  const [newRuleType, setNewRuleType] = useState<api.Rule["type"]>(
    "sender_email",
  );
  const [newRuleValue, setNewRuleValue] = useState("");
  const [connectEmailHint, setConnectEmailHint] = useState("");
  const [listRefreshing, setListRefreshing] = useState(false);
  const pollSyncInFlight = useRef(false);

  const loadSession = useCallback(async () => {
    const t = await SecureStore.getItemAsync(TOKEN_KEY);
    setToken(t);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    initNotificationHandler().catch(() => {});
  }, []);

  const refreshAll = useCallback(async () => {
    if (!token) return;
    const [m, r, c] = await Promise.all([
      api.getMe(token),
      api.getRules(token),
      api.getCaptures(token),
    ]);
    setMe(m);
    setRules(r.rules);
    setCaptures(c.captures);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refreshAll().catch(() => {});
  }, [token, refreshAll]);

  /**
   * Register push token whenever a session exists (including cold start from SecureStore).
   * Without this, users who never tapped "Refresh push registration" have zero device_tokens
   * and sync logs: "new capture but no device_tokens".
   */
  useEffect(() => {
    if (!token) return;
    void registerExpoPushWithApi(token, api.registerDevice);
  }, [token]);

  /** Push taps + foreground pushes refresh Important without manual pull */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeMailNotifications({
      onRefresh: () => refreshAll(),
      onOpen: () => setTab("feed"),
    }).then((unsub: () => void) => {
      if (cancelled) unsub();
      else unsubscribe = unsub;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [token, refreshAll]);

  /** Resume from background: refresh UI and ask server to sync Gmail soon */
  useEffect(() => {
    if (!token) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refreshAll();
        void api.triggerSync(token).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [token, refreshAll]);

  /**
   * Important tab: periodically POST /v1/sync then refetch — otherwise the UI only
   * sees DB rows after the server cron (minutes) or manual pull-to-refresh.
   * Other tabs: infrequent refetch only.
   */
  useEffect(() => {
    if (!token) return;
    const intervalMs = tab === "feed" ? FEED_SYNC_POLL_MS : IDLE_TAB_POLL_MS;
    const id = setInterval(() => {
      if (AppState.currentState !== "active") return;
      if (pollSyncInFlight.current) return;
      pollSyncInFlight.current = true;
      void (async () => {
        try {
          if (tab === "feed") {
            await api.triggerSync(token).catch(() => {});
          }
          await refreshAll();
        } finally {
          pollSyncInFlight.current = false;
        }
      })();
    }, intervalMs);
    return () => clearInterval(id);
  }, [token, refreshAll, tab]);

  /** Entering Important: sync once so the list is not stale until the next interval tick */
  useEffect(() => {
    if (!token || tab !== "feed") return;
    if (AppState.currentState !== "active") return;
    void api.triggerSync(token).catch(() => {});
    void refreshAll();
  }, [token, tab, refreshAll]);

  const registerPush = useCallback(async (session: string) => {
    await registerExpoPushWithApi(session, api.registerDevice);
  }, []);

  const signIn = async () => {
    setBusy(true);
    let linkUrlCaptured: string | undefined;
    const linkSub = Linking.addEventListener("url", ({ url }) => {
      logOAuth("deep_link_received", {
        url: redactUrlForLog(url),
        hasTokenParam: url.includes("token="),
        hasErrorParam: url.includes("error="),
      });
      if (url.includes("token=") || url.includes("error=")) {
        linkUrlCaptured = url;
      }
    });
    try {
      const redirectUri = AuthSession.makeRedirectUri({
        scheme: "nevermiss",
        path: "auth",
      });
      const apiUrl = getApiUrl();
      const hint = connectEmailHint.trim();
      const params = new URLSearchParams();
      params.set("redirect_uri", redirectUri);
      if (hint.includes("@") && hint.length <= 254) {
        params.set("login_hint", hint);
      }
      const authUrl = `${apiUrl}/auth/google?${params.toString()}`;
      logOAuth("session_start", {
        redirectUri,
        apiUrl,
        authUrl,
        platform: Platform.OS,
      });

      let callbackUrl: string | undefined;

      if (Platform.OS === "android") {
        /**
         * expo-web-browser `openAuthSessionAsync` on Android uses a polyfill that
         * Promise.races Linking vs AppState; dismiss often wins and the success URL is lost
         * even when the API already redirected to exp://…?token= (see Render logs).
         * Open a normal tab and wait only on our Linking listener.
         */
        logOAuth("android_using_open_browser_async", {});
        const deeplinkPromise = waitForOAuthDeepLink(
          () => linkUrlCaptured,
          120_000,
        );
        void Promise.resolve(WebBrowser.openBrowserAsync(authUrl)).catch(
          (e: unknown) => {
            logOAuth("open_browser_error", { message: String(e) });
          },
        );
        callbackUrl = await deeplinkPromise;
        await Promise.resolve(WebBrowser.dismissBrowser?.()).catch(() => {});
        logOAuth("android_wait_done", { hasUrl: Boolean(callbackUrl) });
      } else {
        const result = await WebBrowser.openAuthSessionAsync(
          authUrl,
          redirectUri,
        );
        logOAuth("webbrowser_finished", summarizeAuthSessionResult(result));

        callbackUrl = getWebBrowserCallbackUrl(result);

        if (!callbackUrl) {
          logOAuth("poll_deep_link_start", { browserResult: result.type });
          callbackUrl = await waitForOAuthDeepLink(() => linkUrlCaptured);
          if (callbackUrl) {
            logOAuth("poll_deep_link_ok", {
              url: redactUrlForLog(callbackUrl),
            });
          }
        }

        if (!callbackUrl) {
          if (result.type === "dismiss" || result.type === "cancel") {
            logOAuth("user_closed_browser", { type: result.type });
            return;
          }
        }
      }

      if (!callbackUrl) {
        const initial = await Linking.getInitialURL();
        if (
          initial &&
          (initial.includes("token=") || initial.includes("error="))
        ) {
          logOAuth("from_getInitialURL", { url: redactUrlForLog(initial) });
          callbackUrl = initial;
        }
      }

      if (!callbackUrl) {
        logOAuth("no_callback_url", {
          hadCapturedLink: Boolean(linkUrlCaptured),
        });
        Alert.alert(
          "Couldn’t connect",
          Platform.OS === "android"
            ? "Sign-in did not return to the app in time. Finish Google, then when the browser tries to open Expo Go, allow it. Or try again."
            : `No session in the redirect. Browser may have closed too early — try again.`,
        );
        return;
      }

      const parsed = parseAuthRedirect(callbackUrl);
      logOAuth("parsed_redirect", {
        hasToken: Boolean(parsed.token),
        tokenLength: parsed.token?.length ?? 0,
        error: parsed.error ?? null,
      });

      const t = parsed.token;
      const error = parsed.error;
      if (error) {
        Alert.alert("Couldn’t connect", formatConnectError(error));
        return;
      }
      if (!t) {
        logOAuth("parse_failed_empty", {
          callbackUrl: redactUrlForLog(callbackUrl),
        });
        Alert.alert(
          "Couldn’t connect",
          "No session in redirect URL. Check Metro logs for [NeverMiss OAuth] and the line parse_failed_empty.",
        );
        return;
      }
      await SecureStore.setItemAsync(TOKEN_KEY, t);
      setToken(t);
      setConnectEmailHint("");
      logOAuth("session_stored_ok", { tokenLength: t.length });
      await registerPush(t);
      await api.triggerSync(t).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logOAuth("session_throw", { message: msg });
      Alert.alert("Couldn’t connect", msg);
    } finally {
      linkSub.remove();
      setBusy(false);
    }
  };

  const signOut = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setMe(null);
    setRules([]);
    setCaptures([]);
  };

  const addRule = async () => {
    if (!token || !newRuleValue.trim()) return;
    setBusy(true);
    try {
      await api.createRule(token, {
        type: newRuleType,
        value: newRuleValue.trim(),
      });
      setNewRuleValue("");
      await api.triggerSync(token).catch(() => {});
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (r: api.Rule) => {
    if (!token) return;
    await api.patchRule(token, r.id, { enabled: !r.enabled });
    await refreshAll();
  };

  const removeRule = async (id: string) => {
    if (!token) return;
    await api.deleteRule(token, id);
    await refreshAll();
  };

  const openGmail = () => {
    Linking.openURL("https://mail.google.com/");
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingLabel}>Loading</Text>
        <StatusBar style="light" />
      </View>
    );
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <View style={styles.hero}>
          <Text style={styles.title}>Never Miss</Text>
          <Text style={styles.sub}>
            Connect Gmail, define what matters, then see matches here with optional
            alerts.
          </Text>
          <Text style={styles.label}>Email hint (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="you@company.com"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={connectEmailHint}
            onChangeText={setConnectEmailHint}
          />
          <Pressable
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            onPress={signIn}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.primaryBtnText}>Continue with Google</Text>
            )}
          </Pressable>
          {__DEV__ ? (
            <Text style={styles.devHint}>{getApiUrl()}</Text>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerEmail} numberOfLines={1}>
          {me?.email ?? "—"}
        </Text>
      </View>
      <View style={styles.tabBar}>
        {(["feed", "rules", "settings"] as const).map((k) => (
          <Pressable
            key={k}
            style={[styles.tab, tab === k && styles.tabOn]}
            onPress={() => setTab(k)}
          >
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>
              {k === "feed" ? "Important" : k === "rules" ? "Rules" : "Account"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "feed" && (
        <View style={styles.panel}>
          <FlatList
            data={captures}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            refreshing={listRefreshing}
            onRefresh={() => {
              setListRefreshing(true);
              const p = refreshAll();
              const s = token
                ? api.triggerSync(token).catch(() => {})
                : Promise.resolve();
              void Promise.all([p, s]).finally(() => setListRefreshing(false));
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>
                Nothing yet. Add rules, pull down to refresh, or open Gmail from
                Account.
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable style={styles.card} onPress={openGmail}>
                <Text style={styles.cardSubject} numberOfLines={2}>
                  {item.subject || "(No subject)"}
                </Text>
                <Text style={styles.cardFrom} numberOfLines={1}>
                  {item.fromAddr}
                </Text>
                <Text style={styles.cardSnippet} numberOfLines={3}>
                  {item.snippet}
                </Text>
                <Text style={styles.cardMeta}>
                  {new Date(item.receivedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
              </Pressable>
            )}
          />
        </View>
      )}

      {tab === "rules" && (
        <View style={styles.panel}>
          <Text style={styles.rulesIntro}>
            Messages that match a rule appear under Important.
          </Text>
          <Text style={styles.label}>Match</Text>
          <View style={styles.row}>
            {(
              [
                ["sender_email", "Email"],
                ["domain", "Domain"],
                ["gmail_label_id", "Label"],
              ] as const
            ).map(([v, label]) => (
              <Pressable
                key={v}
                style={[
                  styles.chip,
                  newRuleType === v && styles.chipOn,
                ]}
                onPress={() => setNewRuleType(v)}
              >
                <Text
                  style={[
                    styles.chipText,
                    newRuleType === v && styles.chipTextOn,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={styles.input}
            placeholder={
              newRuleType === "domain"
                ? "client.com"
                : newRuleType === "gmail_label_id"
                  ? "Label ID"
                  : "name@company.com"
            }
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            value={newRuleValue}
            onChangeText={setNewRuleValue}
          />
          <Pressable
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            onPress={addRule}
            disabled={busy}
          >
            <Text style={styles.primaryBtnText}>Add rule</Text>
          </Pressable>
          <FlatList
            data={rules}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              rules.length > 0 ? (
                <Text style={styles.sectionTitle}>Active rules</Text>
              ) : null
            }
            ListEmptyComponent={
              <Text style={styles.rulesEmpty}>No rules yet.</Text>
            }
            renderItem={({ item }) => (
              <View style={styles.ruleRow}>
                <View style={styles.ruleMain}>
                  <Text style={styles.ruleType}>{ruleTypeLabel(item.type)}</Text>
                  <Text style={styles.ruleVal} numberOfLines={2}>
                    {item.value}
                  </Text>
                </View>
                <Switch
                  value={item.enabled}
                  onValueChange={() => toggleRule(item)}
                  trackColor={{ false: colors.border, true: colors.accentDim }}
                  thumbColor={item.enabled ? colors.text : colors.placeholder}
                />
                <Pressable
                  onPress={() => removeRule(item.id)}
                  hitSlop={12}
                  style={styles.ruleRemoveHit}
                >
                  <Text style={styles.danger}>Remove</Text>
                </Pressable>
              </View>
            )}
          />
        </View>
      )}

      {tab === "settings" && (
        <View style={styles.panel}>
          <View style={styles.settingsBlock}>
            {me?.lastSyncError ? (
              <Text style={styles.warnBanner}>{me.lastSyncError}</Text>
            ) : null}
            {shouldSkipExpoNotificationsModule() ? (
              <Text style={styles.infoBanner}>
                Remote push is not available in Expo Go on this device. Pull to
                refresh on Important, or use a dev build for push.
              </Text>
            ) : null}
            {me?.deviceTokenCount != null ? (
              <Text style={styles.infoMuted}>
                Push tokens on server: {me.deviceTokenCount}
                {me.deviceTokenCount === 0
                  ? " — tap Refresh push registration below."
                  : ""}
              </Text>
            ) : null}
          </View>
          <Pressable style={styles.secondaryBtn} onPress={openGmail}>
            <Text style={styles.secondaryBtnText}>Open Gmail</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() =>
              token && registerPush(token).catch(() => {})
            }
          >
            <Text style={styles.secondaryBtnText}>Refresh push registration</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => {
              if (!token) return;
              setBusy(true);
              void api
                .sendTestPush(token)
                .then((r: { ok: boolean; deviceCount: number }) => {
                  Alert.alert(
                    "Test push sent",
                    `Requested delivery to ${r.deviceCount} device token(s). Check notification shade in a few seconds.`,
                  );
                  void refreshAll();
                })
                .catch((e: unknown) => {
                  const msg = e instanceof Error ? e.message : String(e);
                  Alert.alert("Test push failed", msg);
                })
                .finally(() => setBusy(false));
            }}
          >
            <Text style={styles.secondaryBtnText}>Send test push</Text>
          </Pressable>
          <View style={styles.settingsSpacer} />
          <Pressable style={styles.linkBtn} onPress={signOut}>
            <Text style={styles.linkText}>Sign out</Text>
          </Pressable>
          <Pressable
            style={[styles.dangerBtn, busy && styles.btnDisabled]}
            onPress={async () => {
              if (!token) return;
              setBusy(true);
              try {
                await api.deleteAccount(token);
                await signOut();
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            <Text style={styles.dangerBtnText}>Delete account</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const colors = {
  bg: "#0b1020",
  surface: "#121a2e",
  surfaceHover: "#182236",
  border: "#2a3650",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  placeholder: "#64748b",
  accent: "#22d3ee",
  accentDim: "#0e7490",
  danger: "#f87171",
  dangerSurface: "#3f1518",
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  loadingLabel: {
    fontSize: 14,
    color: colors.textMuted,
    letterSpacing: 0.3,
  },
  hero: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 32, gap: 14, maxWidth: 440 },
  title: {
    fontSize: 30,
    fontWeight: "700",
    color: colors.text,
    letterSpacing: -0.6,
  },
  sub: { fontSize: 15, color: colors.textMuted, lineHeight: 22 },
  devHint: {
    fontSize: 11,
    color: colors.placeholder,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    marginTop: 4,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerEmail: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabOn: { borderBottomColor: colors.accent },
  tabText: {
    color: colors.textMuted,
    fontWeight: "600",
    fontSize: 14,
  },
  tabTextOn: { color: colors.text },
  panel: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  listContent: { paddingBottom: 24, paddingTop: 4, flexGrow: 1 },
  primaryBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 15,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 6,
  },
  primaryBtnText: { color: colors.bg, fontWeight: "700", fontSize: 16 },
  btnDisabled: { opacity: 0.55 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: colors.surface,
    marginBottom: 10,
  },
  secondaryBtnText: { color: colors.text, fontWeight: "600", fontSize: 15 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  cardSubject: { color: colors.text, fontSize: 16, fontWeight: "600" },
  cardFrom: { color: colors.accent, marginTop: 6, fontSize: 13 },
  cardSnippet: {
    color: colors.textMuted,
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
  },
  cardMeta: { color: colors.placeholder, marginTop: 12, fontSize: 12 },
  empty: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 48,
    paddingHorizontal: 24,
    fontSize: 15,
    lineHeight: 22,
  },
  rulesEmpty: {
    color: colors.placeholder,
    fontSize: 14,
    marginTop: 8,
    marginBottom: 16,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.surfaceHover },
  chipText: { color: colors.textMuted, fontSize: 14, fontWeight: "600" },
  chipTextOn: { color: colors.accent },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 16,
    marginTop: 8,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontWeight: "600",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 4,
  },
  rulesIntro: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  ruleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  ruleMain: { flex: 1, minWidth: 0 },
  ruleType: {
    color: colors.placeholder,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  ruleVal: { color: colors.text, fontSize: 15, fontWeight: "500", marginTop: 4 },
  ruleRemoveHit: { paddingVertical: 4, paddingLeft: 4 },
  danger: { color: colors.danger, fontWeight: "600", fontSize: 14 },
  settingsBlock: { gap: 10, marginBottom: 8 },
  warnBanner: {
    color: "#fcd34d",
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: "#422006",
    padding: 12,
    borderRadius: 10,
    overflow: "hidden",
  },
  infoBanner: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: colors.surface,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoMuted: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  settingsSpacer: { height: 8 },
  dangerBtn: {
    marginTop: 20,
    backgroundColor: colors.dangerSurface,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#7f1d1d",
  },
  dangerBtnText: { color: colors.danger, fontWeight: "700", fontSize: 15 },
  linkBtn: { marginTop: 8, alignItems: "center", paddingVertical: 12 },
  linkText: { color: colors.accent, fontWeight: "600", fontSize: 15 },
});

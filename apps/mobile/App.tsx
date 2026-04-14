import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
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
import * as api from "./src/api";
import {
  initNotificationHandler,
  registerExpoPushWithApi,
  shouldSkipExpoNotificationsModule,
} from "./src/notificationsClient";

WebBrowser.maybeCompleteAuthSession();

const TOKEN_KEY = "nevermiss_session";

type Tab = "feed" | "rules" | "settings";

function parseAuthRedirect(url: string): { token?: string; error?: string } {
  try {
    const q = url.includes("?") ? url.split("?")[1]!.split("#")[0] : "";
    const params = new URLSearchParams(q);
    const token = params.get("token") ?? undefined;
    const error = params.get("error") ?? undefined;
    return { token: token ?? undefined, error: error ?? undefined };
  } catch {
    return {};
  }
}

function formatConnectError(code: string): string {
  const key = decodeURIComponent(code).replace(/\+/g, " ");
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
  const [me, setMe] = useState<Awaited<ReturnType<typeof api.getMe>> | null>(
    null,
  );
  const [rules, setRules] = useState<api.Rule[]>([]);
  const [captures, setCaptures] = useState<api.Capture[]>([]);
  const [newRuleType, setNewRuleType] = useState<api.Rule["type"]>(
    "sender_email",
  );
  const [newRuleValue, setNewRuleValue] = useState("");
  const [connectEmailHint, setConnectEmailHint] = useState("");

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

  const registerPush = useCallback(async (session: string) => {
    await registerExpoPushWithApi(session, api.registerDevice);
  }, []);

  const signIn = async () => {
    setBusy(true);
    try {
      const redirectUri = AuthSession.makeRedirectUri({
        scheme: "nevermiss",
        path: "auth",
      });
      const apiUrl = getApiUrl();
      const hint = connectEmailHint.trim();
      const qs =
        hint.includes("@") && hint.length <= 254
          ? `?login_hint=${encodeURIComponent(hint)}`
          : "";
      const authUrl = `${apiUrl}/auth/google${qs}`;
      const result = await WebBrowser.openAuthSessionAsync(
        authUrl,
        redirectUri,
      );
      if (result.type === "dismiss" || result.type === "cancel") {
        return;
      }
      if (result.type !== "success" || !result.url) {
        Alert.alert(
          "Couldn’t connect",
          "The sign-in window closed before finishing. Try again.",
        );
        return;
      }
      const { token: t, error } = parseAuthRedirect(result.url);
      if (error) {
        Alert.alert("Couldn’t connect", formatConnectError(error));
        return;
      }
      if (!t) {
        Alert.alert(
          "Couldn’t connect",
          "No session was returned. Try signing in again.",
        );
        return;
      }
      await SecureStore.setItemAsync(TOKEN_KEY, t);
      setToken(t);
      setConnectEmailHint("");
      await registerPush(t);
      await api.triggerSync(t).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert("Couldn’t connect", msg);
    } finally {
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
        <ActivityIndicator size="large" color="#38bdf8" />
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
            For people whose mail is in Gmail or Google Workspace: connect that
            mailbox, then say what counts as important (a sender, a domain, or a
            Gmail label). Those messages show up in the app and can notify you
            when new mail matches.
          </Text>
          <Text style={styles.stepHint}>
            1. Connect below → 2. Rules → 3. Important + notifications
          </Text>
          <Text style={styles.label}>Your address (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="you@company.com — speeds up account pick"
            placeholderTextColor="#64748b"
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
              <ActivityIndicator color="#0f172a" />
            ) : (
              <Text style={styles.primaryBtnText}>Connect email with Google</Text>
            )}
          </Pressable>
          <Text style={styles.hint}>API: {getApiUrl()}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Never Miss</Text>
        <Text style={styles.headerSub} numberOfLines={1}>
          {me?.email ?? "…"}
        </Text>
      </View>
      <View style={styles.tabs}>
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
          <Pressable
            style={styles.secondaryBtn}
            onPress={() =>
              token &&
              api.triggerSync(token).then(() => refreshAll()).catch(() => {})
            }
          >
            <Text style={styles.secondaryBtnText}>Sync now</Text>
          </Pressable>
          <FlatList
            data={captures}
            keyExtractor={(item) => item.id}
            refreshing={busy}
            onRefresh={() => {
              setBusy(true);
              refreshAll().finally(() => setBusy(false));
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>
                No important mail here yet. On the Rules tab, add what matters to
                you, then tap Sync now. New matches appear here and send a
                notification if you allowed alerts.
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable style={styles.card} onPress={openGmail}>
                <Text style={styles.cardSubject}>{item.subject}</Text>
                <Text style={styles.cardFrom}>{item.fromAddr}</Text>
                <Text style={styles.cardSnippet} numberOfLines={3}>
                  {item.snippet}
                </Text>
                <Text style={styles.cardMeta}>
                  {new Date(item.receivedAt).toLocaleString()}
                </Text>
              </Pressable>
            )}
          />
        </View>
      )}

      {tab === "rules" && (
        <View style={styles.panel}>
          <Text style={styles.rulesIntro}>
            Tell the app which mail is important. Anything that matches below is
            listed under Important and can notify you.
          </Text>
          <Text style={styles.label}>Match type</Text>
          <View style={styles.row}>
            {(
              [
                ["sender_email", "Email"],
                ["domain", "Domain"],
                ["gmail_label_id", "Label ID"],
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
                ? "e.g. client.com"
                : newRuleType === "gmail_label_id"
                  ? "Gmail label id from API"
                  : "full@address.com"
            }
            placeholderTextColor="#64748b"
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
            ListHeaderComponent={
              <Text style={styles.sectionTitle}>Important-mail rules</Text>
            }
            renderItem={({ item }) => (
              <View style={styles.ruleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ruleType}>{item.type}</Text>
                  <Text style={styles.ruleVal}>{item.value}</Text>
                </View>
                <Switch value={item.enabled} onValueChange={() => toggleRule(item)} />
                <Pressable onPress={() => removeRule(item.id)} hitSlop={8}>
                  <Text style={styles.danger}>Remove</Text>
                </Pressable>
              </View>
            )}
          />
        </View>
      )}

      {tab === "settings" && (
        <View style={styles.panel}>
          {me?.lastSyncError ? (
            <Text style={styles.warn}>Last sync error: {me.lastSyncError}</Text>
          ) : null}
          {shouldSkipExpoNotificationsModule() ? (
            <Text style={styles.warn}>
              Expo Go on Android does not support remote push. Use a development
              build or a physical iOS device with Expo Go to test push, or rely on
              in-app sync.
            </Text>
          ) : null}
          <Text style={styles.body}>
            Notifications use Expo push. For production, configure EAS with FCM
            and APNs credentials.
          </Text>
          <Pressable style={styles.secondaryBtn} onPress={openGmail}>
            <Text style={styles.secondaryBtnText}>Open Gmail</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() =>
              token && registerPush(token).catch(() => {})
            }
          >
            <Text style={styles.secondaryBtnText}>Re-register push token</Text>
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
            <Text style={styles.dangerBtnText}>Delete account & disconnect</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={signOut}>
            <Text style={styles.linkText}>Sign out (this device)</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0f172a" },
  centered: {
    flex: 1,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
  },
  hero: { padding: 24, gap: 16 },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#f8fafc",
    letterSpacing: -0.5,
  },
  sub: { fontSize: 16, color: "#94a3b8", lineHeight: 22 },
  stepHint: {
    fontSize: 14,
    color: "#64748b",
    lineHeight: 20,
    fontWeight: "600",
  },
  hint: { fontSize: 12, color: "#475569", marginTop: 8 },
  header: { paddingHorizontal: 20, paddingBottom: 8 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#f8fafc" },
  headerSub: { fontSize: 14, color: "#94a3b8" },
  tabs: { flexDirection: "row", paddingHorizontal: 12, gap: 8 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#1e293b",
    alignItems: "center",
  },
  tabOn: { backgroundColor: "#38bdf8" },
  tabText: { color: "#94a3b8", fontWeight: "600", fontSize: 13 },
  tabTextOn: { color: "#0f172a" },
  panel: { flex: 1, padding: 16, gap: 12 },
  primaryBtn: {
    backgroundColor: "#38bdf8",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryBtnText: { color: "#0f172a", fontWeight: "700", fontSize: 16 },
  btnDisabled: { opacity: 0.6 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: "#334155",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryBtnText: { color: "#e2e8f0", fontWeight: "600" },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#334155",
  },
  cardSubject: { color: "#f8fafc", fontSize: 17, fontWeight: "700" },
  cardFrom: { color: "#38bdf8", marginTop: 4, fontSize: 13 },
  cardSnippet: { color: "#cbd5e1", marginTop: 8, fontSize: 14, lineHeight: 20 },
  cardMeta: { color: "#64748b", marginTop: 8, fontSize: 12 },
  empty: { color: "#64748b", textAlign: "center", marginTop: 32, paddingHorizontal: 16 },
  label: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
  },
  chipOn: { borderColor: "#38bdf8", backgroundColor: "#082f49" },
  chipText: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: "#7dd3fc" },
  input: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 14,
    color: "#f8fafc",
    borderWidth: 1,
    borderColor: "#334155",
  },
  sectionTitle: {
    color: "#f8fafc",
    fontWeight: "700",
    fontSize: 16,
    marginBottom: 8,
  },
  rulesIntro: {
    color: "#94a3b8",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  ruleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  ruleType: { color: "#64748b", fontSize: 12, textTransform: "uppercase" },
  ruleVal: { color: "#e2e8f0", fontSize: 15, fontWeight: "600" },
  danger: { color: "#f87171", fontWeight: "600", marginLeft: 8 },
  body: { color: "#94a3b8", lineHeight: 22 },
  warn: { color: "#fbbf24", marginBottom: 8 },
  dangerBtn: {
    marginTop: 16,
    backgroundColor: "#450a0a",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#7f1d1d",
  },
  dangerBtnText: { color: "#fecaca", fontWeight: "700" },
  linkBtn: { marginTop: 16, alignItems: "center" },
  linkText: { color: "#38bdf8", fontWeight: "600" },
});

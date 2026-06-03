import React from "react";
import { ShieldCheck } from "lucide-react";
import { BrandMark, Button, TextInput } from "../../components/ui.js";
import { submitPasswordAuth, type AuthStatus } from "../../lib/auth.js";

export function AuthScreen(props: { status: AuthStatus | undefined; onAuthenticated: () => Promise<void> }) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  if (!props.status) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <BrandMark size="hero" className="auth-mark-image" />
          <h1>Mihomo Hive</h1>
          <p>正在检查访问状态...</p>
        </section>
      </main>
    );
  }

  const configured = props.status.configured;

  async function submit() {
    if (!configured && password !== confirm) {
      setMessage("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await submitPasswordAuth({ configured, password });
      setPassword("");
      setConfirm("");
      await props.onAuthenticated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "认证失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <BrandMark size="hero" className="auth-mark-image" />
        <h1>{configured ? "登录 Mihomo Hive" : "设置访问密码"}</h1>
        <p>{configured ? "输入访问密码继续管理固定出口代理池。" : "首次访问需要创建访问密码，之后所有接口都会要求登录。"}</p>
        <div className="auth-form">
          <TextInput
            label="密码"
            value={password}
            onChange={setPassword}
            type="password"
            placeholder="输入访问密码"
            autoComplete={configured ? "current-password" : "new-password"}
            name={configured ? "password" : "new-password"}
          />
          {!configured ? (
            <TextInput
              label="确认密码"
              value={confirm}
              onChange={setConfirm}
              type="password"
              placeholder="再次输入密码"
              autoComplete="new-password"
              name="new-password-confirm"
            />
          ) : null}
          <Button
            icon={<ShieldCheck size={16} />}
            loading={loading}
            disabled={!password || (!configured && !confirm)}
            onClick={submit}
          >
            {configured ? "登录" : "设置并进入"}
          </Button>
          {message ? <div className="form-error">{message}</div> : null}
        </div>
      </section>
    </main>
  );
}

import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in | Ember & Oak admin" };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Ember &amp; Oak admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to see conversations, knowledge and stock.</p>
        <LoginForm />
      </div>
    </main>
  );
}

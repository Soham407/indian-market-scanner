import { Suspense } from "react";
import { LoginForm } from "./_login-form";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

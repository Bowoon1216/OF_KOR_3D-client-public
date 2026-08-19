/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { Component, ReactNode } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { queryClient } from "./api/queryClient";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Dashboard from "./components/Dashboard";
import Header from "./components/Header";
import LoginPage from "./page/LoginPage";
import MainPage from "./page/MainPage";
import MyAssetsPage from "./page/MyAssetsPage";
import SignupPage from "./page/SignupPage";

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="grid min-h-screen place-items-center bg-white p-8 text-slate-900">
          <section className="w-full max-w-2xl border border-slate-200 p-6">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-blue-600">
              Runtime error
            </p>
            <h1 className="mb-4 text-2xl font-semibold">
              The app stopped rendering
            </h1>
            <pre className="overflow-auto whitespace-pre-wrap bg-slate-50 p-4 text-sm leading-relaxed">
              {this.state.error.message}
            </pre>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

/** Header 를 공유하는 앱 레이아웃 */
function AppLayout() {
  return (
    <div className="flex flex-col h-screen bg-white text-slate-900 font-sans selection:bg-slate-200 selection:text-slate-900">
      <Header />
      <Outlet />
    </div>
  );
}

/** 이미 로그인했다면 로그인/회원가입 화면 대신 대시보드로 */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  return isAuthenticated ? <Navigate to="/dashboard" replace /> : <>{children}</>;
}

/** `GET /api/assets` 는 인증이 필요하므로(명세 5.1) 게스트는 로그인으로 보냅니다. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const navigate = useNavigate();
  const { login } = useAuth();

  return (
    <LoginPage
      onSubmit={async ({ email, password }) => {
        await login(email, password);
        navigate("/dashboard", { replace: true });
      }}
      onGoToSignup={() => navigate("/signup")}
    />
  );
}

function SignupRoute() {
  const navigate = useNavigate();
  const { signup } = useAuth();

  return (
    <SignupPage
      onSubmit={async ({ email, password, name, role }) => {
        await signup({ email, password, name, role });
        navigate("/dashboard", { replace: true });
      }}
      onGoToLogin={() => navigate("/login")}
    />
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route
                  path="/assets"
                  element={
                    <RequireAuth>
                      <MyAssetsPage />
                    </RequireAuth>
                  }
                />
                {/*
                  방 입장은 게스트도 가능합니다(명세 1.2).
                  URL 공유만으로 즉시 참여할 수 있어야 하므로 로그인 가드를 두지 않습니다.
                */}
                <Route path="/room/:code" element={<MainPage />} />
              </Route>
              <Route
                path="/login"
                element={
                  <RedirectIfAuthed>
                    <LoginRoute />
                  </RedirectIfAuthed>
                }
              />
              <Route
                path="/signup"
                element={
                  <RedirectIfAuthed>
                    <SignupRoute />
                  </RedirectIfAuthed>
                }
              />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import * as authApi from '../api/auth';
import type { Role, SignupRequest, User } from '../api/types';
import { clearToken, getToken, setToken, subscribeToken } from './tokenStore';

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  /** 저장된 토큰으로 `/api/auth/me` 를 확인하는 동안 true */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<User>;
  signup: (input: SignupRequest) => Promise<User>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  // 토큰이 있으면 그 토큰이 아직 유효한지 확인이 끝날 때까지 로그인 여부를 단정하지 않습니다.
  const [isLoading, setIsLoading] = useState(() => getToken() !== null);

  useEffect(() => {
    if (!getToken()) return;
    const controller = new AbortController();

    authApi
      .me(controller.signal)
      .then((me) => setUser(me))
      .catch(() => {
        // 만료·위조 토큰은 http 계층이 이미 지웠습니다. 서버가 죽어 있을 때도 로그아웃 취급합니다.
        setUser(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    // 어떤 요청이든 401 을 받아 토큰이 버려지면 화면도 로그아웃 상태로 맞춥니다.
    return subscribeToken((token) => {
      if (!token) setUser(null);
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password);
    setToken(result.accessToken, result.expiresIn);
    setUser(result.user);
    setIsLoading(false);
    return result.user;
  }, []);

  const signup = useCallback(
    async (input: SignupRequest) => {
      // 가입 응답에는 토큰이 없으므로(명세 3.1) 곧바로 로그인해 세션을 잇습니다.
      await authApi.signup(input);
      return login(input.email, input.password);
    },
    [login],
  );

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoading,
      login,
      signup,
      logout,
    }),
    [user, isLoading, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export type { Role, User };

import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './errors';

/**
 * 4xx 는 다시 보내도 같은 답이 옵니다. 재시도는 네트워크 오류와 5xx 에만 의미가 있습니다.
 * (401 로 토큰이 정리된 뒤 재시도하면 로그인 화면 전환만 늦어집니다)
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      // 목록을 잠깐 캐시해 화면 전환마다 다시 부르지 않게 합니다.
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

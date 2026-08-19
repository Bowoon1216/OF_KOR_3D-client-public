import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as assetsApi from './assets';
import * as metricsApi from './metrics';
import * as roomsApi from './rooms';
import type { CreateRoomRequest, IfcJob, RoomStatus, UpdateRoomRequest } from './types';

/** 캐시 키를 한곳에 모아 무효화 대상을 놓치지 않게 합니다. */
export const queryKeys = {
  myRooms: (params: { status?: RoomStatus | 'all'; limit?: number; offset?: number }) =>
    ['rooms', 'mine', params] as const,
  room: (code: string) => ['rooms', code] as const,
  assets: (params: { limit?: number; offset?: number }) => ['assets', params] as const,
  roomMetrics: (code: string) => ['metrics', 'rooms', code] as const,
  runSummary: (runId: string) => ['metrics', 'runs', runId, 'summary'] as const,
};

/** Dashboard 의 Recent Activity */
export function useMyRooms(
  params: { status?: RoomStatus | 'all'; limit?: number; offset?: number } = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.myRooms(params),
    queryFn: ({ signal }) => roomsApi.listMyRooms(params, signal),
    enabled: options.enabled ?? true,
  });
}

export function useRoomQuery(code: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.room(code),
    queryFn: ({ signal }) => roomsApi.getRoom(code, signal),
    enabled: (options.enabled ?? true) && roomsApi.isValidRoomCode(code),
  });
}

export function useCreateRoom() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRoomRequest) => roomsApi.createRoom(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['rooms', 'mine'] });
    },
  });
}

export function useUpdateRoom(code: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRoomRequest) => roomsApi.updateRoom(code, body),
    onSuccess: (room) => {
      client.setQueryData(queryKeys.room(code), room);
      void client.invalidateQueries({ queryKey: ['rooms', 'mine'] });
    },
  });
}

export function useEndRoom() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => roomsApi.endRoom(code),
    onSuccess: (_data, code) => {
      void client.invalidateQueries({ queryKey: ['rooms', 'mine'] });
      void client.invalidateQueries({ queryKey: queryKeys.room(code) });
    },
  });
}

export function useAssets(
  params: { limit?: number; offset?: number } = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.assets(params),
    queryFn: ({ signal }) => assetsApi.listAssets(params, signal),
    enabled: options.enabled ?? true,
    // limit 을 늘려 더 불러올 때 목록이 로딩 문구로 깜빡이지 않게 합니다.
    placeholderData: keepPreviousData,
  });
}

/**
 * IFC 업로드 → 서버 변환 완료까지를 한 mutation 으로 묶습니다.
 *
 * 업로드는 진행률 때문에 XHR 을 쓰고, 그 뒤 변환 잡을 폴링합니다. 성공 시 돌려주는
 * 것은 변환이 끝난 GLB 에셋이라 호출부(방 붙이기·목록 갱신)는 바뀌지 않습니다.
 */
export function useUploadIfc() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      label?: string;
      onProgress?: assetsApi.UploadOptions['onProgress'];
      onConverting?: (job: IfcJob) => void;
    }) => {
      const job = await assetsApi.uploadIfc(input.file, {
        label: input.label,
        onProgress: input.onProgress,
      });
      input.onConverting?.(job);
      return assetsApi.waitForIfcJob(job.id, { onProgress: input.onConverting });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['assets'] });
    },
  });
}

export function useDeleteAsset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => assetsApi.deleteAsset(assetId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['assets'] });
    },
  });
}

/**
 * WebSocket `telemetry` 를 못 쓰는 화면(대시보드 등)에서 쓰는 폴링 창구.
 * 방 안에서는 소켓 frame 이 더 빠르므로 이걸 쓰지 않습니다.
 */
export function useRoomMetrics(code: string, options: { enabled?: boolean; intervalMs?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.roomMetrics(code),
    queryFn: ({ signal }) => metricsApi.getRoomMetrics(code, signal),
    enabled: (options.enabled ?? true) && roomsApi.isValidRoomCode(code),
    refetchInterval: options.intervalMs ?? 2000,
    staleTime: 0,
  });
}

export function useRunSummary(runId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.runSummary(runId),
    queryFn: ({ signal }) => metricsApi.getRunSummary(runId, signal),
    enabled: (options.enabled ?? true) && runId.length > 0,
  });
}

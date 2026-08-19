import { Check, Copy, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { toMessage } from '../api/errors';
import { useAssets, useCreateRoom } from '../api/queries';
import {
  DEFAULT_CODE_TTL_HOURS,
  MAX_CODE_TTL_HOURS,
  MIN_CODE_TTL_HOURS,
  rememberCodeExpiry,
} from '../api/roomCodeExpiry';
import type { Room } from '../api/types';
import { formatBytes, formatDateTime } from '../utils/time';
import AssetUploadButton from './AssetUploadButton';

/** 명세 4.1 의 예시(`ARCHI-COLLAB`, `STRUCTURAL-REVIEW`)를 포함한 자주 쓰는 값들. */
const CATEGORY_PRESETS = [
  'ARCHI-COLLAB',
  'STRUCTURAL-REVIEW',
  'MEP-REVIEW',
  'CLIENT-REVIEW',
];

const TITLE_MAX = 120;
const CATEGORY_MAX = 32;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 32;
const DEFAULT_PARTICIPANTS = 6;

const TTL_OPTIONS = Array.from(
  { length: MAX_CODE_TTL_HOURS - MIN_CODE_TTL_HOURS + 1 },
  (_, index) => MIN_CODE_TTL_HOURS + index,
);

const fieldLabel = 'mb-2 block text-[10px] font-bold uppercase tracking-widest text-slate-400';
const fieldBox =
  'h-12 w-full border border-slate-200 bg-white px-4 text-sm text-slate-900 placeholder:text-slate-300 transition-colors focus:border-slate-900 focus:outline-none';

type NewSessionDialogProps = {
  onClose: () => void;
  /** 생성한 세션으로 이동합니다. */
  onEnter: (code: string) => void;
};

/**
 * Dashboard 의 **New Session**.
 *
 * 명세 4.1 `POST /api/rooms` 의 `title` · `category` · `assetId` · `maxParticipants` 를 모두 받고,
 * 명세에 아직 없는 코드 유효기간은 `codeExpiresInHours` 로 함께 보냅니다(4.1 표 밖의 확장 필드).
 * 도면은 방을 만든 뒤 `PATCH` 로 붙일 수도 있지만, 여기서 먼저 고르면 입장하자마자 보입니다.
 */
export default function NewSessionDialog({ onClose, onEnter }: NewSessionDialogProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(CATEGORY_PRESETS[0]);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [maxParticipants, setMaxParticipants] = useState(DEFAULT_PARTICIPANTS);
  const [ttlHours, setTtlHours] = useState(DEFAULT_CODE_TTL_HOURS);

  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [created, setCreated] = useState<{ room: Room; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const assetsQuery = useAssets({ limit: 50 });
  const createRoom = useCreateRoom();

  const submit = async () => {
    setError(undefined);

    const trimmedTitle = title.trim();
    const trimmedCategory = category.trim();
    if (trimmedTitle.length > TITLE_MAX) {
      setError(`세션 이름은 ${TITLE_MAX}자를 넘을 수 없습니다.`);
      return;
    }
    if (trimmedCategory.length > CATEGORY_MAX) {
      setError(`카테고리는 ${CATEGORY_MAX}자를 넘을 수 없습니다.`);
      return;
    }
    if (
      !Number.isInteger(maxParticipants) ||
      maxParticipants < MIN_PARTICIPANTS ||
      maxParticipants > MAX_PARTICIPANTS
    ) {
      setError(`최대 수용 인원은 ${MIN_PARTICIPANTS}~${MAX_PARTICIPANTS}명입니다.`);
      return;
    }

    try {
      // 빈 값은 아예 빼서 서버 기본값(제목은 `Session #{코드 앞 4자리}`)이 살아 있게 합니다.
      const room = await createRoom.mutateAsync({
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...(trimmedCategory ? { category: trimmedCategory } : {}),
        ...(assetId ? { assetId } : {}),
        maxParticipants,
        codeExpiresInHours: ttlHours,
      });
      setCreated({ room, expiresAt: rememberCodeExpiry(room.code, ttlHours) });
    } catch (cause) {
      setError(toMessage(cause, '세션을 만들지 못했습니다.'));
    }
  };

  const shareUrl = created ? `${window.location.origin}/room/${created.room.code}` : '';

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('클립보드에 복사하지 못했습니다. 주소를 직접 복사해 주세요.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="새 세션 만들기"
        className="flex max-h-[86vh] w-full max-w-2xl flex-col border border-slate-200 bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-slate-100 p-8">
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-blue-600">
              New session
            </p>
            <h2 className="font-serif text-2xl italic">
              {created ? '세션이 만들어졌습니다' : '새 3D 세션 만들기'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="cursor-pointer text-slate-400 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {created ? (
          <div className="flex flex-col gap-8 p-8">
            <div className="border border-slate-200 p-8 text-center">
              <p className={fieldLabel}>Session code</p>
              <p className="font-mono text-4xl tracking-[0.2em] text-slate-900">
                {created.room.code}
              </p>
              <p className="mt-4 text-xs text-slate-400">
                이 코드만 있으면 로그인 없이도 게스트로 입장할 수 있습니다.
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
              <dt className="text-slate-400">세션 이름</dt>
              <dd className="text-right font-medium">{created.room.title}</dd>
              <dt className="text-slate-400">카테고리</dt>
              <dd className="text-right font-medium">{created.room.category}</dd>
              <dt className="text-slate-400">최대 수용 인원</dt>
              <dd className="text-right font-medium">{created.room.maxParticipants}명</dd>
              <dt className="text-slate-400">3D 도면</dt>
              <dd className="text-right font-medium">
                {created.room.asset?.entryFilename ?? '방 안에서 선택'}
              </dd>
              <dt className="text-slate-400">코드 유효기간</dt>
              <dd className="text-right font-medium">
                {ttlHours}시간 · {formatDateTime(new Date(created.expiresAt).toISOString())}까지
              </dd>
            </dl>

            <div className="flex items-center gap-3 border border-slate-200 p-4">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-500">
                {shareUrl}
              </span>
              <button
                type="button"
                onClick={() => void copyShareUrl()}
                className="flex shrink-0 cursor-pointer items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-900"
              >
                {copied ? <Check className="h-4 w-4 text-blue-600" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>

            {error && (
              <p role="alert" className="border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="h-12 flex-1 cursor-pointer border border-slate-900 bg-white text-[10px] font-bold uppercase tracking-widest text-slate-900 transition-colors hover:bg-slate-900 hover:text-white"
              >
                닫기
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => onEnter(created.room.code)}
                className="h-12 flex-[2] cursor-pointer border border-slate-900 bg-slate-900 text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-slate-900"
              >
                세션 입장
              </button>
            </div>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex-1 overflow-y-auto p-8">
              <div className="grid grid-cols-2 gap-6">
                <div className="col-span-2">
                  <label htmlFor="session-title" className={fieldLabel}>
                    세션 타이틀
                  </label>
                  <input
                    id="session-title"
                    autoFocus
                    maxLength={TITLE_MAX}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="비워 두면 Session #코드 앞 4자리"
                    className={fieldBox}
                  />
                </div>

                <div>
                  <label htmlFor="session-category" className={fieldLabel}>
                    카테고리 (선택)
                  </label>
                  <input
                    id="session-category"
                    list="session-category-presets"
                    maxLength={CATEGORY_MAX}
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    placeholder="ARCHI-COLLAB"
                    className={fieldBox}
                  />
                  <datalist id="session-category-presets">
                    {CATEGORY_PRESETS.map((preset) => (
                      <option key={preset} value={preset} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label htmlFor="session-max" className={fieldLabel}>
                    최대 수용 인원
                  </label>
                  <input
                    id="session-max"
                    type="number"
                    inputMode="numeric"
                    min={MIN_PARTICIPANTS}
                    max={MAX_PARTICIPANTS}
                    value={maxParticipants}
                    onChange={(event) => setMaxParticipants(Number(event.target.value))}
                    className={fieldBox}
                  />
                  <p className="mt-2 text-xs text-slate-400">
                    {MIN_PARTICIPANTS}~{MAX_PARTICIPANTS}명
                  </p>
                </div>

                <div className="col-span-2">
                  <label htmlFor="session-ttl" className={fieldLabel}>
                    코드 유효기간
                  </label>
                  <select
                    id="session-ttl"
                    value={ttlHours}
                    onChange={(event) => setTtlHours(Number(event.target.value))}
                    className={`${fieldBox} cursor-pointer`}
                  >
                    {TTL_OPTIONS.map((hours) => (
                      <option key={hours} value={hours}>
                        {hours}시간{hours === DEFAULT_CODE_TTL_HOURS ? ' (기본)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs text-slate-400">
                    최소 {MIN_CODE_TTL_HOURS}시간 ~ 최대 {MAX_CODE_TTL_HOURS}시간. 시간 단위로
                    고릅니다.
                  </p>
                </div>
              </div>

              <div className="mt-8 border-t border-slate-100 pt-8">
                <div className="mb-4 flex items-center justify-between">
                  <span className={`${fieldLabel} mb-0`}>3D 에셋 (선택)</span>
                  {/* 방금 올린 에셋을 바로 이 세션에 붙입니다. */}
                  <AssetUploadButton
                    variant="inline"
                    onUploaded={(asset) => setAssetId(asset.id)}
                    onError={setError}
                    onBusyChange={setUploading}
                  />
                </div>

                <div className="max-h-52 space-y-2 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => setAssetId(null)}
                    className={`flex w-full items-center justify-between border p-4 text-left transition-colors cursor-pointer ${
                      assetId === null
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-slate-200 hover:border-slate-900'
                    }`}
                  >
                    <span className="text-sm text-slate-500">
                      나중에 방 안에서 붙이기 (assetId 없이 생성)
                    </span>
                    {assetId === null && <Check className="h-4 w-4 text-blue-600" />}
                  </button>

                  {assetsQuery.isPending ? (
                    <p className="flex items-center gap-2 p-4 text-sm text-slate-400">
                      <Loader2 className="h-4 w-4 animate-spin" /> 에셋 목록을 불러오는 중...
                    </p>
                  ) : assetsQuery.isError ? (
                    <p className="p-4 text-sm text-red-600">{toMessage(assetsQuery.error)}</p>
                  ) : (
                    assetsQuery.data.items.map((asset) => {
                      const selected = asset.id === assetId;
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          onClick={() => setAssetId(asset.id)}
                          className={`flex w-full items-center justify-between border p-4 text-left transition-colors cursor-pointer ${
                            selected
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-slate-200 hover:border-slate-900'
                          }`}
                        >
                          <span>
                            <span className="block text-sm font-bold text-slate-900">
                              {asset.label || asset.entryFilename}
                            </span>
                            <span className="mt-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
                              {asset.entryFilename} · {formatBytes(asset.sizeBytes)} ·{' '}
                              {asset.fileCount} files
                            </span>
                          </span>
                          {selected && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="mt-6 border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600"
                >
                  {error}
                </p>
              )}
            </div>

            <footer className="flex gap-3 border-t border-slate-100 p-8">
              <button
                type="button"
                onClick={onClose}
                className="h-12 flex-1 cursor-pointer border border-slate-900 bg-white text-[10px] font-bold uppercase tracking-widest text-slate-900 transition-colors hover:bg-slate-900 hover:text-white"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={createRoom.isPending || uploading}
                className="flex h-12 flex-[2] cursor-pointer items-center justify-center gap-3 border border-slate-900 bg-slate-900 text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-900 disabled:hover:text-white"
              >
                {createRoom.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {createRoom.isPending ? 'Creating...' : '세션 만들기'}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

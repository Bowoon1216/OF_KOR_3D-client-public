import { Loader2, Upload } from 'lucide-react';
import { DragEvent, useRef, useState } from 'react';
import { toMessage } from '../api/errors';
import { useUploadIfc } from '../api/queries';
import type { Asset } from '../api/types';

/**
 * 서버가 받는 확장자(`UNSUPPORTED_EXTENSION`).
 *
 * 사용자가 올리는 것은 **BIM 원본 IFC 뿐**입니다. 건축가는 Revit·ArchiCAD 를 쓰고,
 * GLB 변환은 서버가 합니다. `.glb` 를 올리면 서버가 415 로 거절합니다.
 */
export const ASSET_ACCEPT = '.ifc,.ifczip';

export type AssetUploadVariant = 'dropzone' | 'inline';

export interface AssetUploadButtonProps {
  /** 업로드가 끝난 뒤 호출됩니다. Promise 를 돌려주면 그동안 버튼이 계속 잠깁니다. */
  onUploaded?: (asset: Asset) => void | Promise<void>;
  /**
   * 넘기면 에러 문구를 직접 띄웁니다(부모 화면에 이미 에러 자리가 있는 경우).
   * 넘기지 않으면 이 컴포넌트가 버튼 아래에 직접 표시합니다.
   * 새 업로드를 시작할 때는 `undefined` 로 한 번 호출해 이전 문구를 지웁니다.
   */
  onError?: (message: string | undefined) => void;
  /** 업로드가 도는 동안 부모 폼의 제출 버튼 등을 함께 잠그고 싶을 때 씁니다. */
  onBusyChange?: (busy: boolean) => void;
  /** `dropzone` = 큰 점선 박스(+드래그 앤 드롭), `inline` = 한 줄짜리 텍스트 버튼 */
  variant?: AssetUploadVariant;
  label?: string;
  disabled?: boolean;
  className?: string;
}

/** 업로드는 두 단계입니다. 전송이 끝나도 서버 변환이 남아 있습니다. */
type Phase = { kind: 'idle' } | { kind: 'sending'; ratio: number | null } | {
  kind: 'converting';
  progress: number;
};

/**
 * BIM 에셋 업로드 버튼. 대시보드의 내 에셋 페이지, 세션 생성 다이얼로그,
 * 방 안의 도면 선택 다이얼로그가 모두 이 컴포넌트를 씁니다.
 *
 * **IFC 만 받습니다.** 전송이 끝나면 서버가 GLB 로 변환하고, 이 컴포넌트는 변환이
 * 끝날 때까지 기다린 뒤 `onUploaded` 에 완성된 에셋을 넘깁니다. 32.9MB IFC 의 변환이
 * 약 196초 걸리므로 두 단계를 따로 표시합니다 — 전송 100% 에서 멈춘 것처럼 보이면
 * 사용자는 실패로 읽습니다.
 */
export default function AssetUploadButton({
  onUploaded,
  onError,
  onBusyChange,
  variant = 'dropzone',
  label = 'IFC 업로드',
  disabled = false,
  className = '',
}: AssetUploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [ownError, setOwnError] = useState<string>();

  const uploadIfc = useUploadIfc();
  const busy = phase.kind !== 'idle';

  const report = (message?: string) => {
    if (onError) onError(message);
    else setOwnError(message);
  };

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    report(undefined);
    setPhase({ kind: 'sending', ratio: 0 });
    onBusyChange?.(true);
    try {
      // 반복 필드가 아니라 한 파일만 받습니다. 여러 개를 고르면 첫 번째만 올립니다.
      const asset = await uploadIfc.mutateAsync({
        file: files[0],
        onProgress: (progress) => setPhase({ kind: 'sending', ratio: progress.ratio }),
        onConverting: (job) => setPhase({ kind: 'converting', progress: job.progress }),
      });
      await onUploaded?.(asset);
    } catch (cause) {
      report(toMessage(cause, '업로드에 실패했습니다.'));
    } finally {
      setPhase({ kind: 'idle' });
      onBusyChange?.(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled || busy) return;
    void upload(Array.from(event.dataTransfer.files));
  };

  const percent =
    phase.kind === 'sending'
      ? phase.ratio === null
        ? null
        : Math.round(phase.ratio * 100)
      : phase.kind === 'converting'
        ? phase.progress
        : null;

  const content = busy ? (
    <>
      <Loader2 className="h-4 w-4 animate-spin" />
      {phase.kind === 'converting'
        ? `서버에서 변환 중 ${percent ?? 0}%`
        : percent === null
          ? '업로드 중...'
          : `업로드 중 ${percent}%`}
    </>
  ) : (
    <>
      <Upload className="h-4 w-4" />
      {label}
    </>
  );

  const dropzoneStyle = `flex w-full cursor-pointer items-center justify-center gap-3 border border-dashed px-6 py-6 text-[10px] font-bold uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    dragging
      ? 'border-blue-500 bg-blue-50 text-blue-600'
      : 'border-slate-300 text-slate-500 hover:border-slate-900 hover:text-slate-900'
  }`;
  const inlineStyle =
    'flex cursor-pointer items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className={className}>
      <input
        ref={fileInputRef}
        type="file"
        accept={ASSET_ACCEPT}
        className="hidden"
        onChange={(event) => void upload(Array.from(event.target.files ?? []))}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={
          variant === 'dropzone'
            ? (event) => {
                event.preventDefault();
                setDragging(true);
              }
            : undefined
        }
        onDragLeave={variant === 'dropzone' ? () => setDragging(false) : undefined}
        onDrop={variant === 'dropzone' ? handleDrop : undefined}
        className={variant === 'dropzone' ? dropzoneStyle : inlineStyle}
      >
        {content}
      </button>

      {variant === 'dropzone' && percent !== null && (
        <div className="mt-4 h-px w-full bg-slate-200">
          <div className="h-0.5 bg-blue-500" style={{ width: `${percent}%` }} />
        </div>
      )}

      {!onError && ownError && (
        <p role="alert" className="mt-4 border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">
          {ownError}
        </p>
      )}
    </div>
  );
}

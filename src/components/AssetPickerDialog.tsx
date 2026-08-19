import { Check, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { toMessage } from '../api/errors';
import { useAssets, useUpdateRoom } from '../api/queries';
import { formatBytes } from '../utils/time';
import AssetUploadButton from './AssetUploadButton';

type AssetPickerDialogProps = {
  roomCode: string;
  currentAssetId?: string | null;
  onClose: () => void;
};

/**
 * 방에 붙일 3D 도면을 고르거나 새로 올립니다.
 *
 * 선택하면 `PATCH /api/rooms/{code}` 로 `assetId` 를 바꾸고, 서버가 접속자 전원에게
 * `assetChanged` 를 전파합니다. 클라이언트가 개별로 로드 명령을 뿌리지 않습니다.
 */
export default function AssetPickerDialog({
  roomCode,
  currentAssetId,
  onClose,
}: AssetPickerDialogProps) {
  const [error, setError] = useState<string>();

  const assetsQuery = useAssets({ limit: 50 });
  const updateRoom = useUpdateRoom(roomCode);

  const attach = async (assetId: string) => {
    setError(undefined);
    try {
      await updateRoom.mutateAsync({ assetId });
      onClose();
    } catch (cause) {
      setError(toMessage(cause, '도면을 붙이지 못했습니다.'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6">
      <section className="flex max-h-[80vh] w-full max-w-2xl flex-col border border-slate-200 bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-100 p-8">
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-blue-600">Assets</p>
            <h2 className="font-serif text-2xl italic">3D 도면 선택</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-900 cursor-pointer"
            aria-label="닫기"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="border-b border-slate-100 p-8">
          {/* 올리자마자 이 방에 붙입니다. 서버가 접속자 전원에게 assetChanged 를 전파합니다. */}
          <AssetUploadButton onUploaded={(asset) => attach(asset.id)} onError={setError} />
          <p className="mt-4 text-xs leading-relaxed text-slate-400">
            Revit·ArchiCAD 가 내보낸 <strong>.ifc</strong> 를 올리면 서버가 변환합니다. 변환이
            끝난 뒤 이 방에 붙으므로, 큰 파일은 몇 분 걸릴 수 있습니다.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-8">
          {error && (
            <p role="alert" className="mb-6 border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">
              {error}
            </p>
          )}

          {assetsQuery.isPending ? (
            <p className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 목록을 불러오는 중...
            </p>
          ) : assetsQuery.isError ? (
            <p className="text-sm text-red-600">{toMessage(assetsQuery.error)}</p>
          ) : assetsQuery.data.items.length === 0 ? (
            <p className="text-sm text-slate-400">아직 올린 도면이 없습니다.</p>
          ) : (
            <ul className="space-y-3">
              {assetsQuery.data.items.map((asset) => {
                const isCurrent = asset.id === currentAssetId;
                return (
                  <li key={asset.id}>
                    <button
                      type="button"
                      disabled={updateRoom.isPending}
                      onClick={() => void attach(asset.id)}
                      className={`flex w-full items-center justify-between border p-5 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                        isCurrent
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 hover:border-slate-900'
                      }`}
                    >
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          {asset.label || asset.entryFilename}
                        </div>
                        <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                          {asset.entryFilename} · {formatBytes(asset.sizeBytes)} · {asset.fileCount} files
                        </div>
                        {/* sha256 은 9월과 10월이 같은 바이트를 측정했는지 증명하는 근거입니다. */}
                        <div className="mt-1 font-mono text-[10px] text-slate-300">
                          {asset.sha256.slice(0, 16)}…
                        </div>
                      </div>
                      {isCurrent && <Check className="h-4 w-4 text-blue-600" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

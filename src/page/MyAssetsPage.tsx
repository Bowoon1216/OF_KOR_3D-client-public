import { Box, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toMessage } from '../api/errors';
import { useAssets, useDeleteAsset } from '../api/queries';
import AssetUploadButton from '../components/AssetUploadButton';
import { formatBytes, formatDateTime } from '../utils/time';

const PAGE_SIZE = 24;

/**
 * 내가 올린 3D 에셋 목록 (`GET /api/assets` — 명세상 내 것만 내려옵니다).
 *
 * 세션을 만들기 전에 도면을 미리 올려 두고, 필요 없어진 것을 지우는 화면입니다.
 * 업로드 버튼은 세션 생성·방 안 도면 선택과 같은 `AssetUploadButton` 을 씁니다.
 */
export default function MyAssetsPage() {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [error, setError] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();

  const assetsQuery = useAssets({ limit });
  const deleteAsset = useDeleteAsset();

  const handleDelete = async (assetId: string, name: string) => {
    if (!window.confirm(`"${name}" 을(를) 삭제할까요? 이 도면을 쓰는 세션에서는 보이지 않게 됩니다.`)) {
      return;
    }
    setError(undefined);
    setDeletingId(assetId);
    try {
      await deleteAsset.mutateAsync(assetId);
    } catch (cause) {
      setError(toMessage(cause, '에셋을 삭제하지 못했습니다.'));
    } finally {
      setDeletingId(undefined);
    }
  };

  const items = assetsQuery.data?.items ?? [];
  const total = assetsQuery.data?.total ?? 0;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-8 py-16">
        <header className="mb-12">
          <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.3em] text-blue-600">
            My assets
          </span>
          <h1 className="mb-4 font-serif text-5xl leading-[1.1]">
            내가 업로드한 <span className="font-light italic">3D 에셋</span>
          </h1>
          <p className="text-sm font-medium leading-relaxed text-slate-500">
            세션에 붙일 도면을 미리 올려 두세요. 여기 올린 에셋은 세션을 만들 때와 방 안에서
            그대로 고를 수 있습니다.
          </p>
        </header>

        <AssetUploadButton
          className="mb-8"
          onError={setError}
          label="IFC 업로드 (드래그해서 놓아도 됩니다)"
        />

        <p className="mb-8 text-xs leading-relaxed text-slate-400">
          Revit·ArchiCAD 가 내보낸 <strong>.ifc</strong> 를 그대로 올리세요 (.ifczip 도 됩니다).
          서버가 3D 뷰어용으로 변환합니다. 전송이 끝나도 변환이 남아 있어, 큰 파일은 몇 분
          걸릴 수 있습니다. 파일 하나씩, 최대 1024MB 입니다.
        </p>

        {error && (
          <p role="alert" className="mb-8 border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">
            {error}
          </p>
        )}

        <div className="mb-4 flex items-baseline justify-between border-b border-slate-100 pb-4">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Uploaded
          </span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {total}개
          </span>
        </div>

        {assetsQuery.isPending ? (
          <p className="flex items-center gap-2 py-12 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> 목록을 불러오는 중...
          </p>
        ) : assetsQuery.isError ? (
          <p className="py-12 text-sm text-red-600">{toMessage(assetsQuery.error)}</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-4 border border-dashed border-slate-200 py-20 text-center">
            <Box className="h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-400">아직 올린 도면이 없습니다.</p>
          </div>
        ) : (
          <>
            <ul className="space-y-3">
              {items.map((asset) => (
                <li
                  key={asset.id}
                  className="flex items-center justify-between gap-6 border border-slate-200 p-5 transition-colors hover:border-slate-900"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-slate-900">
                      {asset.label || asset.entryFilename}
                    </div>
                    <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                      {asset.entryFilename} · {formatBytes(asset.sizeBytes)} · {asset.fileCount} files
                    </div>
                    <div className="mt-1 text-[10px] text-slate-400">
                      {formatDateTime(asset.uploadedAt)}
                    </div>
                    {/* sha256 은 9월과 10월이 같은 바이트를 측정했는지 증명하는 근거입니다. */}
                    <div className="mt-1 font-mono text-[10px] text-slate-300">
                      {asset.sha256.slice(0, 16)}…
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={deletingId !== undefined}
                    onClick={() => void handleDelete(asset.id, asset.label || asset.entryFilename)}
                    aria-label="삭제"
                    className="flex shrink-0 cursor-pointer items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {deletingId === asset.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Delete
                  </button>
                </li>
              ))}
            </ul>

            {items.length < total && (
              <button
                type="button"
                onClick={() => setLimit((current) => current + PAGE_SIZE)}
                className="mt-6 h-12 w-full cursor-pointer border border-slate-900 bg-white text-[10px] font-bold uppercase tracking-widest text-slate-900 transition-colors hover:bg-slate-900 hover:text-white"
              >
                더 보기 ({items.length} / {total})
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}

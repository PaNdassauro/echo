import { useLocation } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Fallback do Suspense das rotas lazy: skeleton com a geometria da rota de
 * destino em vez do spinner centralizado genérico (skeleton quando a forma do
 * conteúdo é conhecida; spinner só em ações pontuais dentro de botões).
 * Lê o pathname para escolher a forma — o Suspense vive dentro do Router.
 */
const DashboardSkeleton = ({ isMobile }: { isMobile: boolean }) => (
  <div className="h-dvh flex bg-background">
    {/* Lista de conversas */}
    <div className={isMobile ? "w-full flex flex-col" : "w-96 border-r flex flex-col shrink-0"}>
      <div className="p-4 pt-[max(1rem,env(safe-area-inset-top))] border-b space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
        <Skeleton className="h-9 rounded-md" />
      </div>
      <div className="flex-1 overflow-hidden">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2.5">
            <Skeleton className="w-11 h-11 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    </div>
    {/* Área do chat (desktop) */}
    {!isMobile && (
      <div className="flex-1 flex flex-col">
        <div className="h-16 border-b flex items-center gap-3 px-4">
          <Skeleton className="w-10 h-10 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1" />
        <div className="h-16 border-t flex items-center px-4">
          <Skeleton className="h-11 flex-1 rounded-3xl" />
        </div>
      </div>
    )}
  </div>
);

const SettingsSkeleton = ({ isMobile }: { isMobile: boolean }) => {
  if (isMobile) {
    return (
      <div className="min-h-dvh bg-background">
        <div className="h-14 border-b flex items-center px-4">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Skeleton className="w-10 h-10 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-44" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-screen bg-background">
      <div className="w-64 border-r p-6 space-y-4">
        <Skeleton className="h-6 w-40" />
        <div className="space-y-2 pt-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9 rounded-md" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-8 space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
};

const GenericPageSkeleton = () => (
  <div className="min-h-dvh bg-background">
    <div className="border-b">
      <div className="container mx-auto px-4 py-4 flex items-center gap-3">
        <Skeleton className="h-6 w-6 rounded-md" />
        <Skeleton className="h-6 w-40" />
      </div>
    </div>
    <div className="container mx-auto px-4 pt-6 space-y-4">
      <Skeleton className="h-12 rounded-lg" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  </div>
);

export const RouteSkeleton = () => {
  const { pathname } = useLocation();
  const isMobile = useIsMobile();

  if (pathname.startsWith("/dashboard")) return <DashboardSkeleton isMobile={isMobile} />;
  if (pathname.startsWith("/settings")) return <SettingsSkeleton isMobile={isMobile} />;
  return <GenericPageSkeleton />;
};

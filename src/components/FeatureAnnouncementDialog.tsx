import { useEffect, useState } from "react";
import { Sparkles, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Versão do aviso. Bump aqui = todo mundo vê o próximo lote de novidades,
 * mesmo quem já fechou o anterior (a chave do localStorage carrega a versão).
 */
const ANNOUNCEMENT_VERSION = "2026-11";
const ANNOUNCEMENT_STORAGE_PREFIX = `echo_whatsnew_${ANNOUNCEMENT_VERSION}_seen_`;

function getAnnouncementStorageKey(userId: string) {
  return `${ANNOUNCEMENT_STORAGE_PREFIX}${userId}`;
}

interface AnnouncedFeature {
  icon: LucideIcon;
  title: string;
  description: string;
}

/** Novidades do lote atual. Vazia, o aviso não aparece (instalação nova não tem o que anunciar). */
const FEATURES: AnnouncedFeature[] = [];

interface FeatureAnnouncementDialogProps {
  userId: string;
  features?: AnnouncedFeature[];
}

export default function FeatureAnnouncementDialog({ userId, features = FEATURES }: FeatureAnnouncementDialogProps) {
  const [open, setOpen] = useState(false);
  const hasFeatures = features.length > 0;

  useEffect(() => {
    if (!hasFeatures) return;
    if (localStorage.getItem(getAnnouncementStorageKey(userId))) return;
    const timer = setTimeout(() => setOpen(true), 600);
    return () => clearTimeout(timer);
  }, [userId, hasFeatures]);

  /** "Entendi": não volta mais. */
  const dismissForever = () => {
    localStorage.setItem(getAnnouncementStorageKey(userId), new Date().toISOString());
    setOpen(false);
  };

  /** "Depois", Esc e clique fora: fecha sem gravar, então reaparece no próximo acesso. */
  const dismissForNow = () => setOpen(false);

  if (!hasFeatures) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && dismissForNow()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto sm:mx-0 h-10 w-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
            <Sparkles className="h-5 w-5" />
          </div>
          <DialogTitle className="pt-1">Novidades no Echo</DialogTitle>
          <DialogDescription>{features.length === 1 ? "Uma novidade no painel." : `${features.length} novidades no painel.`}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="flex items-start gap-3">
                <span
                  className="flex-none h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center"
                  aria-hidden="true"
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-snug">{feature.title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground text-pretty">
                    {feature.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={dismissForNow}>
            Depois
          </Button>
          <Button type="button" onClick={dismissForever}>
            Entendi, vamos lá
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

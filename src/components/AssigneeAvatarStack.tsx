import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface Profile {
    id: string;
    first_name: string | null;
    last_name: string | null;
    full_name: string | null;
}

interface AssigneeAvatarStackProps {
    /** UUIDs of the co-owners to display. */
    coOwners: string[];
    /** Max avatars before showing "+N" (default 3). */
    max?: number;
    /** Compact mode: smaller avatars for use in list cards. */
    compact?: boolean;
    /** Optional click handler (opens the share dialog). */
    onClick?: () => void;
    className?: string;
}

// Module-level cache — shared across instances so we don't hammer Supabase
const profileCache = new Map<string, Profile>();
const inflightRequests = new Map<string, Promise<void>>();

const fetchProfiles = async (ids: string[]): Promise<void> => {
    const missing = ids.filter((id) => !profileCache.has(id) && !inflightRequests.has(id));
    if (missing.length === 0) {
        // Wait for any inflight requests that cover ids we need
        const waits = ids
            .map((id) => inflightRequests.get(id))
            .filter((p): p is Promise<void> => p !== undefined);
        await Promise.all(waits);
        return;
    }

    const promise = (async () => {
        const { data, error } = await supabase
            .from("profiles")
            .select("id, first_name, last_name, full_name")
            .in("id", missing);

        if (error) {
            console.error("[AssigneeAvatarStack] Error fetching profiles:", error);
            return;
        }

        for (const profile of data || []) {
            profileCache.set(profile.id, profile as Profile);
        }
    })();

    // Mark all missing ids as in-flight
    for (const id of missing) {
        inflightRequests.set(id, promise);
    }

    try {
        await promise;
    } finally {
        for (const id of missing) {
            inflightRequests.delete(id);
        }
    }
};

const getInitials = (profile: Profile | undefined): string => {
    if (!profile) return "?";
    if (profile.full_name) {
        return profile.full_name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .toUpperCase()
            .substring(0, 2);
    }
    const first = profile.first_name?.[0] || "";
    const last = profile.last_name?.[0] || "";
    return (first + last).toUpperCase() || "?";
};

export const AssigneeAvatarStack = ({
    coOwners,
    max = 3,
    compact = false,
    onClick,
    className,
}: AssigneeAvatarStackProps) => {
    const [, forceRender] = useState(0);

    useEffect(() => {
        if (coOwners.length === 0) return;
        let cancelled = false;
        void fetchProfiles(coOwners).then(() => {
            if (!cancelled) {
                forceRender((n) => n + 1);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [coOwners]);

    const profiles = useMemo(
        () => coOwners.map((id) => profileCache.get(id)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [coOwners, profileCache.size],
    );

    if (coOwners.length === 0) return null;

    const visibleProfiles = profiles.slice(0, max);
    const overflow = Math.max(0, profiles.length - max);

    const size = compact ? "h-5 w-5" : "h-7 w-7";
    const fontSize = compact ? "text-2xs" : "text-xs";
    const overlap = compact ? "-ml-1" : "-ml-1.5";
    const border = compact ? "border border-background" : "border-2 border-background";

    const content = (
        <div className={cn("flex items-center", className)}>
            {visibleProfiles.map((profile, idx) => (
                <Avatar
                    key={coOwners[idx]}
                    className={cn(
                        size,
                        border,
                        idx > 0 ? overlap : "",
                    )}
                    title={
                        profile?.full_name ||
                        `${profile?.first_name ?? ""} ${profile?.last_name ?? ""}`.trim() ||
                        "Co-proprietário"
                    }
                >
                    <AvatarFallback
                        className={cn(
                            "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                            fontSize,
                        )}
                    >
                        {getInitials(profile)}
                    </AvatarFallback>
                </Avatar>
            ))}
            {overflow > 0 && (
                <Avatar className={cn(size, border, overlap)}>
                    <AvatarFallback
                        className={cn(
                            "bg-muted text-muted-foreground",
                            fontSize,
                        )}
                    >
                        +{overflow}
                    </AvatarFallback>
                </Avatar>
            )}
        </div>
    );

    if (onClick) {
        return (
            <button
                type="button"
                onClick={onClick}
                className="inline-flex items-center hover:opacity-80 transition-opacity"
                title="Gerenciar atendentes da conversa"
            >
                {content}
            </button>
        );
    }

    return content;
};

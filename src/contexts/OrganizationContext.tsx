
import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type OrgRole = 'admin' | 'agent';

export interface Organization {
    id: string;
    name: string;
    slug: string;
}

interface OrganizationContextType {
    organizations: Organization[];
    currentOrganization: Organization | null;
    userRole: OrgRole | null;
    isSuperAdmin: boolean;
    isLoading: boolean;
    setCurrentOrganization: (org: Organization) => void;
    refreshOrganizations: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

export const OrganizationProvider = ({ children }: { children: ReactNode }) => {
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [currentOrganization, setCurrentOrganization] = useState<Organization | null>(null);
    const [userRole, setUserRole] = useState<OrgRole | null>(null);
    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    const fetchOrganizations = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                setOrganizations([]);
                setCurrentOrganization(null);
                setIsLoading(false);
                return;
            }

            // 1. Check if Super Admin
            // 1. Check if Super Admin
            const { data: profile } = await supabase
                .from('profiles')
                .select('is_super_admin' as any)
                .eq('id', session.user.id)
                .single();

            const superAdmin = (profile as any)?.is_super_admin || false;
            setIsSuperAdmin(superAdmin);

            // 2. Fetch Organizations
            let orgsData: Organization[] = [];

            if (superAdmin) {
                // Super Admin sees ALL organizations
                const { data, error } = await (supabase
                    .from('organizations')
                    .select('id, name, slug')
                    .order('name') as any);

                if (error) throw error;
                orgsData = data || [];
            } else {
                // Normal users see only their memberships
                const { data, error } = await (supabase
                    .from('organizations')
                    .select('id, name, slug')
                    .order('name') as any);
                // Note: RLS will filter this automatically to only show orgs the user is a member of

                if (error) throw error;
                orgsData = data || [];
            }

            setOrganizations(orgsData);

            // 3. Set Current Organization (Restore from local storage or default to first)
            if (orgsData.length > 0) {
                const storedOrgId = localStorage.getItem('selectedOrganizationId');
                const found = orgsData.find(o => o.id === storedOrgId);
                const selected = found || orgsData[0];
                setCurrentOrganization(selected);
            } else {
                setCurrentOrganization(null);
            }

        } catch (error: any) {
            console.error('Error fetching organizations:', error);
            toast.error(`Failed to load organizations: ${error.message || error}`);
        } finally {
            setIsLoading(false);
        }
    };

    // Fetch role when current organization changes
    useEffect(() => {
        const fetchRole = async () => {
            if (!currentOrganization) {
                setUserRole(null);
                return;
            }

            // If super admin, they are effectively admin, but let's check explicit membership too or just give admin access
            if (isSuperAdmin) {
                // Super admin implies full access, treating as 'admin' for UI purposes
                // But strictly, we might want to know if they are a member. 
                // For now, let's treat super admin as 'admin' role in any org they view.
                setUserRole('admin');
                return;
            }

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            const { data, error } = await (supabase
                .from('organization_members')
                .select('role')
                .eq('organization_id', currentOrganization.id)
                .eq('user_id', session.user.id)
                .maybeSingle() as any); // Use maybeSingle as they might not be a member if super admin logic was different

            if (data) {
                setUserRole((data as any).role as OrgRole);
            } else {
                setUserRole(null);
            }
        };

        fetchRole();
        if (currentOrganization) {
            localStorage.setItem('selectedOrganizationId', currentOrganization.id);
        }
    }, [currentOrganization, isSuperAdmin]);

    useEffect(() => {
        fetchOrganizations();

        const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
            fetchOrganizations();
        });

        return () => subscription.unsubscribe();
    }, []);

    const handleSetCurrentOrganization = (org: Organization) => {
        setCurrentOrganization(org);
    };

    return (
        <OrganizationContext.Provider value={{
            organizations,
            currentOrganization,
            userRole,
            isSuperAdmin,
            isLoading,
            setCurrentOrganization: handleSetCurrentOrganization,
            refreshOrganizations: fetchOrganizations
        }}>
            {children}
        </OrganizationContext.Provider>
    );
};

export const useOrganization = () => {
    const context = useContext(OrganizationContext);
    if (context === undefined) {
        throw new Error('useOrganization must be used within an OrganizationProvider');
    }
    return context;
};

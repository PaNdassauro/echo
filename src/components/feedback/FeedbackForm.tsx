import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X, Send, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn, checkEdgeFunctionResponseAsync } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/contexts/OrganizationContext";
import { supabase } from "@/integrations/supabase/client";
import { getRuntimeConfig } from "@/lib/runtimeConfig";

import {
  feedbackSchema,
  FeedbackFormData,
  FeedbackTypeValue,
  feedbackTypeLabels,
} from "./feedbackSchema";

interface FeedbackFormProps {
  onClose: () => void;
}

export default function FeedbackForm({ onClose }: FeedbackFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const { toast } = useToast();
  const { currentOrganization } = useOrganization();

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUserEmail(user?.email ?? null);
    };
    getUser();
  }, []);

  const form = useForm<FeedbackFormData>({
    resolver: zodResolver(feedbackSchema),
    defaultValues: {
      type: undefined,
      title: "",
      details: "",
    },
  });

  const selectedType = form.watch("type");

  const onSubmit = async (data: FeedbackFormData) => {
    setIsSubmitting(true);
    try {
      const webhookUrl = getRuntimeConfig().feedbackWebhookUrl;

      const payload = {
        type: data.type,
        typeLabel: feedbackTypeLabels[data.type],
        title: data.title,
        details: data.details,
        user: userEmail,
        sector: currentOrganization?.name ?? null,
        sectorId: currentOrganization?.id ?? null,
        timestamp: new Date().toISOString(),
        url: window.location.href,
      };

      // Webhook e e-mail para o time saem juntos. Basta um dos dois
      // chegar para o feedback não se perder; a falha do outro fica no console.
      const sendToWebhook = async () => {
        if (!webhookUrl) {
          throw new Error("webhook de feedback não configurado (feedbackWebhookUrl em /config.js)");
        }
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      };
      const sendEmail = async () => {
        await checkEdgeFunctionResponseAsync(
          await supabase.functions.invoke("send-feedback-email", {
            body: {
              type: data.type,
              title: data.title,
              details: data.details,
              organization_id: currentOrganization?.id ?? null,
              url: window.location.href,
            },
          })
        );
      };

      const [webhook, email] = await Promise.allSettled([sendToWebhook(), sendEmail()]);
      if (webhook.status === "rejected") {
        console.error("Failed to send feedback to webhook:", webhook.reason);
      }
      if (email.status === "rejected") {
        console.error("Failed to send feedback email:", email.reason);
      }
      if (webhook.status === "rejected" && email.status === "rejected") {
        throw email.reason;
      }

      toast({
        title: "Feedback enviado",
        description: "Obrigado pelo retorno.",
      });

      form.reset();
      onClose();
    } catch (error) {
      console.error("Failed to submit feedback:", error);
      toast({
        title: "Não foi possível enviar o feedback",
        description: "Verifique a conexão e tente novamente.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const feedbackTypes = Object.entries(feedbackTypeLabels) as [
    FeedbackTypeValue,
    string
  ][];

  return (
    <div className="bg-card border border-border rounded-lg shadow-xl p-4 sm:p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-foreground">Enviar Feedback</h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-8 w-8 rounded-full"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Feedback Type Selection */}
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tipo de feedback</FormLabel>
                <FormControl>
                  <RadioGroup
                    onValueChange={field.onChange}
                    value={field.value}
                    className="space-y-2"
                  >
                    {feedbackTypes.map(([value, label]) => (
                      <div
                        key={value}
                        className={cn(
                          "flex items-center space-x-3 p-3 rounded-md border",
                          "cursor-pointer transition-colors",
                          field.value === value
                            ? "border-primary bg-primary/10"
                            : "border-border hover:bg-accent"
                        )}
                        onClick={() => field.onChange(value)}
                      >
                        <RadioGroupItem value={value} id={value} />
                        <Label
                          htmlFor={value}
                          className="cursor-pointer flex-1 text-foreground"
                        >
                          {label}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Title and Details - Shows after type selection */}
          <AnimatePresence>
            {selectedType && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Título</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="Resumo do seu feedback…"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="details"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Detalhes</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="Descreva seu feedback em detalhes…"
                          rows={4}
                          className="resize-none"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Submit Button */}
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting || !selectedType}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Enviando…
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Enviar feedback
              </>
            )}
          </Button>
        </form>
      </Form>
    </div>
  );
}

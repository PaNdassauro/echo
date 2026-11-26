export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      action_button_phone_numbers: {
        Row: {
          action_button_id: string
          created_at: string
          id: string
          phone_number_id: string
        }
        ComputedFields: never
        Insert: {
          action_button_id: string
          created_at?: string
          id?: string
          phone_number_id: string
        }
        Update: {
          action_button_id?: string
          created_at?: string
          id?: string
          phone_number_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_button_phone_numbers_action_button_id_fkey"
            columns: ["action_button_id"]
            isOneToOne: false
            referencedRelation: "organization_action_buttons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_button_phone_numbers_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      analytics_daily_metrics: {
        Row: {
          conversation_count: number | null
          created_at: string | null
          currency: string | null
          date: string
          id: string
          organization_id: string
          total_cost: number | null
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          conversation_count?: number | null
          created_at?: string | null
          currency?: string | null
          date: string
          id?: string
          organization_id: string
          total_cost?: number | null
          updated_at?: string | null
        }
        Update: {
          conversation_count?: number | null
          created_at?: string | null
          currency?: string | null
          date?: string
          id?: string
          organization_id?: string
          total_cost?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_daily_metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      analytics_daily_templates: {
        Row: {
          category: string | null
          clicked: number | null
          components: Json | null
          created_at: string | null
          date: string
          delivered: number | null
          id: string
          organization_id: string
          read: number | null
          sent: number | null
          template_id: string
          template_name: string
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          category?: string | null
          clicked?: number | null
          components?: Json | null
          created_at?: string | null
          date: string
          delivered?: number | null
          id?: string
          organization_id: string
          read?: number | null
          sent?: number | null
          template_id: string
          template_name: string
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          clicked?: number | null
          components?: Json | null
          created_at?: string | null
          date?: string
          delivered?: number | null
          id?: string
          organization_id?: string
          read?: number | null
          sent?: number | null
          template_id?: string
          template_name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_daily_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          key_hash: string
          key_preview: string
          last_used_at: string | null
          name: string
          organization_id: string | null
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          key_hash: string
          key_preview: string
          last_used_at?: string | null
          name: string
          organization_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          key_hash?: string
          key_preview?: string
          last_used_at?: string | null
          name?: string
          organization_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      automation_executions: {
        Row: {
          completed_at: string | null
          contact_phone: string | null
          conversation_id: string | null
          error: string | null
          execution_log: NonNullable<Json>
          flow_id: string | null
          id: string
          matched_by: string | null
          organization_id: string
          phone_number_id: string | null
          session_id: string | null
          started_at: string
          status: string
          stop_reason: string | null
          trigger_message: Json | null
          trigger_type: string | null
        }
        ComputedFields: never
        Insert: {
          completed_at?: string | null
          contact_phone?: string | null
          conversation_id?: string | null
          error?: string | null
          execution_log?: NonNullable<Json>
          flow_id?: string | null
          id?: string
          matched_by?: string | null
          organization_id: string
          phone_number_id?: string | null
          session_id?: string | null
          started_at?: string
          status?: string
          stop_reason?: string | null
          trigger_message?: Json | null
          trigger_type?: string | null
        }
        Update: {
          completed_at?: string | null
          contact_phone?: string | null
          conversation_id?: string | null
          error?: string | null
          execution_log?: NonNullable<Json>
          flow_id?: string | null
          id?: string
          matched_by?: string | null
          organization_id?: string
          phone_number_id?: string | null
          session_id?: string | null
          started_at?: string
          status?: string
          stop_reason?: string | null
          trigger_message?: Json | null
          trigger_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_executions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_executions_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "automation_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_executions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_executions_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_executions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "automation_sessions"
            referencedColumns: ["id"]
          }
        ]
      }
      automation_flows: {
        Row: {
          cooldown_minutes: number | null
          created_at: string
          description: string | null
          flow_data: NonNullable<Json>
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          phone_number_id: string | null
          run_in_groups: boolean
          trigger_config: Json | null
          trigger_type: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          cooldown_minutes?: number | null
          created_at?: string
          description?: string | null
          flow_data?: NonNullable<Json>
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          phone_number_id?: string | null
          run_in_groups?: boolean
          trigger_config?: Json | null
          trigger_type: string
          updated_at?: string
        }
        Update: {
          cooldown_minutes?: number | null
          created_at?: string
          description?: string | null
          flow_data?: NonNullable<Json>
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          phone_number_id?: string | null
          run_in_groups?: boolean
          trigger_config?: Json | null
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_flows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_flows_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      automation_sessions: {
        Row: {
          context: Json | null
          conversation_id: string
          created_at: string
          current_node_id: string
          expires_at: string | null
          flow_id: string
          id: string
          status: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          context?: Json | null
          conversation_id: string
          created_at?: string
          current_node_id: string
          expires_at?: string | null
          flow_id: string
          id?: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          context?: Json | null
          conversation_id?: string
          created_at?: string
          current_node_id?: string
          expires_at?: string | null
          flow_id?: string
          id?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_sessions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_sessions_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "automation_flows"
            referencedColumns: ["id"]
          }
        ]
      }
      automation_triggers: {
        Row: {
          created_at: string
          flow_id: string
          id: string
          is_active: boolean | null
          trigger_config: Json | null
          trigger_type: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          flow_id: string
          id?: string
          is_active?: boolean | null
          trigger_config?: Json | null
          trigger_type: string
        }
        Update: {
          created_at?: string
          flow_id?: string
          id?: string
          is_active?: boolean | null
          trigger_config?: Json | null
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_triggers_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "automation_flows"
            referencedColumns: ["id"]
          }
        ]
      }
      aviso_de_mensagem: {
        Row: {
          chave: string
          corpo: Json | null
          criado_em: string
          entregue_em: string | null
          estado: string
          evento: string
          falou: Json | null
          id: string
          message_id: string
          organization_id: string
          proxima_em: string | null
          tem_autor: boolean
          tentativas: number
          ultimo_erro: string | null
        }
        ComputedFields: never
        Insert: {
          chave: string
          corpo?: Json | null
          criado_em?: string
          entregue_em?: string | null
          estado?: string
          evento: string
          falou?: Json | null
          id?: string
          message_id: string
          organization_id: string
          proxima_em?: string | null
          tem_autor?: boolean
          tentativas?: number
          ultimo_erro?: string | null
        }
        Update: {
          chave?: string
          corpo?: Json | null
          criado_em?: string
          entregue_em?: string | null
          estado?: string
          evento?: string
          falou?: Json | null
          id?: string
          message_id?: string
          organization_id?: string
          proxima_em?: string | null
          tem_autor?: boolean
          tentativas?: number
          ultimo_erro?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "aviso_de_mensagem_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      broadcast_recipients: {
        Row: {
          attempts: number
          broadcast_id: string
          claimed_at: string | null
          contact_name: string | null
          created_at: string | null
          error_message: string | null
          id: string
          phone_number: string
          sent_at: string | null
          status: string | null
          updated_at: string
          variables: Json | null
          whatsapp_message_id: string | null
        }
        ComputedFields: never
        Insert: {
          attempts?: number
          broadcast_id: string
          claimed_at?: string | null
          contact_name?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          phone_number: string
          sent_at?: string | null
          status?: string | null
          updated_at?: string
          variables?: Json | null
          whatsapp_message_id?: string | null
        }
        Update: {
          attempts?: number
          broadcast_id?: string
          claimed_at?: string | null
          contact_name?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          phone_number?: string
          sent_at?: string | null
          status?: string | null
          updated_at?: string
          variables?: Json | null
          whatsapp_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcast_recipients_broadcast_id_fkey"
            columns: ["broadcast_id"]
            isOneToOne: false
            referencedRelation: "broadcasts"
            referencedColumns: ["id"]
          }
        ]
      }
      broadcasts: {
        Row: {
          body_variable_count: number | null
          button_variable_count: number | null
          completed_at: string | null
          concurrency: number
          created_at: string | null
          created_by: string | null
          failed_count: number | null
          header_media: Json | null
          id: string
          last_dispatch_at: string | null
          name: string
          organization_id: string
          phone_number_id: string
          scheduled_at: string | null
          sent_count: number | null
          started_at: string | null
          status: string
          template_components: Json | null
          template_id: string
          template_language: string
          template_name: string
          throttled_at: string | null
          total_recipients: number | null
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          body_variable_count?: number | null
          button_variable_count?: number | null
          completed_at?: string | null
          concurrency?: number
          created_at?: string | null
          created_by?: string | null
          failed_count?: number | null
          header_media?: Json | null
          id?: string
          last_dispatch_at?: string | null
          name: string
          organization_id: string
          phone_number_id: string
          scheduled_at?: string | null
          sent_count?: number | null
          started_at?: string | null
          status?: string
          template_components?: Json | null
          template_id: string
          template_language?: string
          template_name: string
          throttled_at?: string | null
          total_recipients?: number | null
          updated_at?: string | null
        }
        Update: {
          body_variable_count?: number | null
          button_variable_count?: number | null
          completed_at?: string | null
          concurrency?: number
          created_at?: string | null
          created_by?: string | null
          failed_count?: number | null
          header_media?: Json | null
          id?: string
          last_dispatch_at?: string | null
          name?: string
          organization_id?: string
          phone_number_id?: string
          scheduled_at?: string | null
          sent_count?: number | null
          started_at?: string | null
          status?: string
          template_components?: Json | null
          template_id?: string
          template_language?: string
          template_name?: string
          throttled_at?: string | null
          total_recipients?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcasts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "broadcasts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "broadcasts_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      close_reasons: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string | null
          phone_number_id: string | null
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id?: string | null
          phone_number_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string | null
          phone_number_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "close_reasons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "close_reasons_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      conversation_assignees: {
        Row: {
          added_at: string
          added_by: string | null
          conversation_id: string
          id: string
          role: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          added_at?: string
          added_by?: string | null
          conversation_id: string
          id?: string
          role?: string
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          conversation_id?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_assignees_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          }
        ]
      }
      conversation_notes: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          created_by: string | null
          id: string
        }
        ComputedFields: never
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          created_by?: string | null
          id?: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_notes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      conversation_prefs: {
        Row: {
          archived_at: string | null
          conversation_id: string
          muted_until: string | null
          pinned_at: string | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          archived_at?: string | null
          conversation_id: string
          muted_until?: string | null
          pinned_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          conversation_id?: string
          muted_until?: string | null
          pinned_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_prefs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          }
        ]
      }
      conversation_reads: {
        Row: {
          conversation_id: string
          last_read_at: string
          marked_unread_at: string | null
          user_id: string
        }
        ComputedFields: never
        Insert: {
          conversation_id: string
          last_read_at?: string
          marked_unread_at?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          last_read_at?: string
          marked_unread_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_reads_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          }
        ]
      }
      conversation_tags: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          tag_id: string
        }
        ComputedFields: never
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          tag_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_tags_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          }
        ]
      }
      conversations: {
        Row: {
          assigned_to: string | null
          br_phone_key: string | null
          channel: string
          close_reason: string | null
          closed_at: string | null
          closed_by: string | null
          contact_avatar_updated_at: string | null
          contact_avatar_url: string | null
          contact_name: string
          contact_phone: string
          contact_picture_url: string | null
          created_at: string
          disparo_campanhas: string[] | null
          disparo_desde: string | null
          disparo_msg_id: string | null
          disparo_origem: string | null
          disparo_rotulo: string | null
          disparo_status: string | null
          group_jid: string | null
          group_subject: string | null
          ia_desde: string | null
          ia_origem: string | null
          ia_sem_resposta_desde: string | null
          id: string
          instagram_account_id: string | null
          instagram_user_id: string | null
          instagram_username: string | null
          is_group: boolean | null
          last_auto_reply_at: string | null
          last_message_at: string
          last_message_content: string | null
          last_message_direction: string | null
          last_message_is_deleted: boolean | null
          last_message_type: string | null
          phone_number_id: string | null
          picture_fetched_at: string | null
          sector_id: string | null
          source: string | null
          status: string | null
          updated_at: string
          whatsapp_id: string | null
        }
        ComputedFields: never
        Insert: {
          assigned_to?: string | null
          br_phone_key?: never
          channel?: string
          close_reason?: string | null
          closed_at?: string | null
          closed_by?: string | null
          contact_avatar_updated_at?: string | null
          contact_avatar_url?: string | null
          contact_name: string
          contact_phone: string
          contact_picture_url?: string | null
          created_at?: string
          disparo_campanhas?: string[] | null
          disparo_desde?: string | null
          disparo_msg_id?: string | null
          disparo_origem?: string | null
          disparo_rotulo?: string | null
          disparo_status?: string | null
          group_jid?: string | null
          group_subject?: string | null
          ia_desde?: string | null
          ia_origem?: string | null
          ia_sem_resposta_desde?: string | null
          id?: string
          instagram_account_id?: string | null
          instagram_user_id?: string | null
          instagram_username?: string | null
          is_group?: boolean | null
          last_auto_reply_at?: string | null
          last_message_at?: string
          last_message_content?: string | null
          last_message_direction?: string | null
          last_message_is_deleted?: boolean | null
          last_message_type?: string | null
          phone_number_id?: string | null
          picture_fetched_at?: string | null
          sector_id?: string | null
          source?: string | null
          status?: string | null
          updated_at?: string
          whatsapp_id?: string | null
        }
        Update: {
          assigned_to?: string | null
          br_phone_key?: never
          channel?: string
          close_reason?: string | null
          closed_at?: string | null
          closed_by?: string | null
          contact_avatar_updated_at?: string | null
          contact_avatar_url?: string | null
          contact_name?: string
          contact_phone?: string
          contact_picture_url?: string | null
          created_at?: string
          disparo_campanhas?: string[] | null
          disparo_desde?: string | null
          disparo_msg_id?: string | null
          disparo_origem?: string | null
          disparo_rotulo?: string | null
          disparo_status?: string | null
          group_jid?: string | null
          group_subject?: string | null
          ia_desde?: string | null
          ia_origem?: string | null
          ia_sem_resposta_desde?: string | null
          id?: string
          instagram_account_id?: string | null
          instagram_user_id?: string | null
          instagram_username?: string | null
          is_group?: boolean | null
          last_auto_reply_at?: string | null
          last_message_at?: string
          last_message_content?: string | null
          last_message_direction?: string | null
          last_message_is_deleted?: boolean | null
          last_message_type?: string | null
          phone_number_id?: string | null
          picture_fetched_at?: string | null
          sector_id?: string | null
          source?: string | null
          status?: string | null
          updated_at?: string
          whatsapp_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_sector_id_fkey"
            columns: ["sector_id"]
            isOneToOne: false
            referencedRelation: "sectors"
            referencedColumns: ["id"]
          }
        ]
      }
      disconnect_alert_log: {
        Row: {
          alert_sent_at: string
          created_at: string
          disconnected_at: string
          emails_sent: string[]
          error_message: string | null
          id: string
          phone_number_id: string
          success: boolean | null
        }
        ComputedFields: never
        Insert: {
          alert_sent_at?: string
          created_at?: string
          disconnected_at: string
          emails_sent: string[]
          error_message?: string | null
          id?: string
          phone_number_id: string
          success?: boolean | null
        }
        Update: {
          alert_sent_at?: string
          created_at?: string
          disconnected_at?: string
          emails_sent?: string[]
          error_message?: string | null
          id?: string
          phone_number_id?: string
          success?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "disconnect_alert_log_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      group_participant_aliases: {
        Row: {
          alias: string
          created_at: string | null
          created_by: string | null
          group_jid: string
          id: string
          organization_id: string
          participant_jid: string
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          alias: string
          created_at?: string | null
          created_by?: string | null
          group_jid: string
          id?: string
          organization_id: string
          participant_jid: string
          updated_at?: string | null
        }
        Update: {
          alias?: string
          created_at?: string | null
          created_by?: string | null
          group_jid?: string
          id?: string
          organization_id?: string
          participant_jid?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_participant_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_participant_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      instagram_connections: {
        Row: {
          access_token: string
          connected_at: string
          display_name: string | null
          id: string
          ig_user_id: string
          ig_username: string | null
          inbox_mode: string
          last_error: string | null
          organization_id: string
          phone_number_id: string
          scopes: string[]
          status: string
          subscribed_fields: string[]
          token_expires_at: string | null
          token_refresh_tried_at: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          access_token: string
          connected_at?: string
          display_name?: string | null
          id?: string
          ig_user_id: string
          ig_username?: string | null
          inbox_mode?: string
          last_error?: string | null
          organization_id: string
          phone_number_id: string
          scopes?: string[]
          status?: string
          subscribed_fields?: string[]
          token_expires_at?: string | null
          token_refresh_tried_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string
          connected_at?: string
          display_name?: string | null
          id?: string
          ig_user_id?: string
          ig_username?: string | null
          inbox_mode?: string
          last_error?: string | null
          organization_id?: string
          phone_number_id?: string
          scopes?: string[]
          status?: string
          subscribed_fields?: string[]
          token_expires_at?: string | null
          token_refresh_tried_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instagram_connections_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: true
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      instagram_webhook_events: {
        Row: {
          event_at: string | null
          event_hash: string
          event_type: string
          id: number
          ig_account_id: string | null
          mid: string | null
          object: string | null
          payload: NonNullable<Json>
          process_note: string | null
          processed_at: string | null
          received_at: string
          recipient_id: string | null
          sender_id: string | null
          signature_valid: boolean
          tentativas: number
        }
        ComputedFields: never
        Insert: {
          event_at?: string | null
          event_hash: string
          event_type: string
          id?: number
          ig_account_id?: string | null
          mid?: string | null
          object?: string | null
          payload: NonNullable<Json>
          process_note?: string | null
          processed_at?: string | null
          received_at?: string
          recipient_id?: string | null
          sender_id?: string | null
          signature_valid: boolean
          tentativas?: number
        }
        Update: {
          event_at?: string | null
          event_hash?: string
          event_type?: string
          id?: number
          ig_account_id?: string | null
          mid?: string | null
          object?: string | null
          payload?: NonNullable<Json>
          process_note?: string | null
          processed_at?: string | null
          received_at?: string
          recipient_id?: string | null
          sender_id?: string | null
          signature_valid?: boolean
          tentativas?: number
        }
        Relationships: []
      }
      linha_identidade: {
        Row: {
          identidade: string
          origem: string
          phone_number_id: string
          visto_em: string
        }
        ComputedFields: never
        Insert: {
          identidade: string
          origem: string
          phone_number_id: string
          visto_em?: string
        }
        Update: {
          identidade?: string
          origem?: string
          phone_number_id?: string
          visto_em?: string
        }
        Relationships: [
          {
            foreignKeyName: "linha_identidade_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      message_hidden: {
        Row: {
          hidden_at: string
          message_id: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          hidden_at?: string
          message_id: string
          user_id: string
        }
        Update: {
          hidden_at?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_hidden_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          }
        ]
      }
      message_reactions: {
        Row: {
          emoji: string
          id: string
          is_from_me: boolean
          message_id: string
          reacted_at: string
          reactor_jid: string | null
          reactor_name: string | null
          reactor_user_id: string | null
        }
        ComputedFields: never
        Insert: {
          emoji: string
          id?: string
          is_from_me?: boolean
          message_id: string
          reacted_at?: string
          reactor_jid?: string | null
          reactor_name?: string | null
          reactor_user_id?: string | null
        }
        Update: {
          emoji?: string
          id?: string
          is_from_me?: boolean
          message_id?: string
          reacted_at?: string
          reactor_jid?: string | null
          reactor_name?: string | null
          reactor_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          }
        ]
      }
      message_receipts: {
        Row: {
          delivered_at: string | null
          id: string
          message_id: string
          participant_jid: string
          participant_phone: string | null
          read_at: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          delivered_at?: string | null
          id?: string
          message_id: string
          participant_jid: string
          participant_phone?: string | null
          read_at?: string | null
          updated_at?: string
        }
        Update: {
          delivered_at?: string | null
          id?: string
          message_id?: string
          participant_jid?: string
          participant_phone?: string | null
          read_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_receipts_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          }
        ]
      }
      messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          deleted_at: string | null
          direction: string
          edited_at: string | null
          error_message: string | null
          flow_response_json: Json | null
          flow_token: string | null
          id: string
          is_deleted: boolean
          is_edited: boolean
          is_imported: boolean
          media_filename: string | null
          media_mime_type: string | null
          media_size_bytes: number | null
          media_url: string | null
          message_type: string | null
          metadata: Json | null
          our_reaction: string | null
          quoted_message_id: string | null
          reaction: string | null
          read_at: string | null
          sender_jid: string | null
          sender_name: string | null
          sender_phone: string | null
          sent_by: string | null
          status: string | null
          whatsapp_message_id: string | null
        }
        ComputedFields: never
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          deleted_at?: string | null
          direction: string
          edited_at?: string | null
          error_message?: string | null
          flow_response_json?: Json | null
          flow_token?: string | null
          id?: string
          is_deleted?: boolean
          is_edited?: boolean
          is_imported?: boolean
          media_filename?: string | null
          media_mime_type?: string | null
          media_size_bytes?: number | null
          media_url?: string | null
          message_type?: string | null
          metadata?: Json | null
          our_reaction?: string | null
          quoted_message_id?: string | null
          reaction?: string | null
          read_at?: string | null
          sender_jid?: string | null
          sender_name?: string | null
          sender_phone?: string | null
          sent_by?: string | null
          status?: string | null
          whatsapp_message_id?: string | null
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          deleted_at?: string | null
          direction?: string
          edited_at?: string | null
          error_message?: string | null
          flow_response_json?: Json | null
          flow_token?: string | null
          id?: string
          is_deleted?: boolean
          is_edited?: boolean
          is_imported?: boolean
          media_filename?: string | null
          media_mime_type?: string | null
          media_size_bytes?: number | null
          media_url?: string | null
          message_type?: string | null
          metadata?: Json | null
          our_reaction?: string | null
          quoted_message_id?: string | null
          reaction?: string | null
          read_at?: string | null
          sender_jid?: string | null
          sender_name?: string | null
          sender_phone?: string | null
          sent_by?: string | null
          status?: string | null
          whatsapp_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_quoted_message_id_fkey"
            columns: ["quoted_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      organization_action_buttons: {
        Row: {
          button_type: string
          created_at: string
          icon: string
          id: string
          is_active: boolean | null
          label: string
          organization_id: string
          position: number
          updated_at: string
          url: string | null
        }
        ComputedFields: never
        Insert: {
          button_type?: string
          created_at?: string
          icon?: string
          id?: string
          is_active?: boolean | null
          label?: string
          organization_id: string
          position?: number
          updated_at?: string
          url?: string | null
        }
        Update: {
          button_type?: string
          created_at?: string
          icon?: string
          id?: string
          is_active?: boolean | null
          label?: string
          organization_id?: string
          position?: number
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_action_buttons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["org_role"]
          sector_id: string | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role?: Database["public"]["Enums"]["org_role"]
          sector_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["org_role"]
          sector_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_sector_id_fkey"
            columns: ["sector_id"]
            isOneToOne: false
            referencedRelation: "sectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      organization_webhooks: {
        Row: {
          created_at: string
          id: string
          is_active: boolean | null
          organization_id: string
          updated_at: string
          url: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          organization_id: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          organization_id?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_webhooks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      organizations: {
        Row: {
          ai_api_key: string | null
          ai_api_key_encrypted: string | null
          ai_insights_prompt: string | null
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
          whatsapp_access_token: string | null
          whatsapp_app_id: string | null
          whatsapp_verify_token: string | null
          whatsapp_waba_id: string | null
        }
        ComputedFields: never
        Insert: {
          ai_api_key?: string | null
          ai_api_key_encrypted?: string | null
          ai_insights_prompt?: string | null
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
          whatsapp_access_token?: string | null
          whatsapp_app_id?: string | null
          whatsapp_verify_token?: string | null
          whatsapp_waba_id?: string | null
        }
        Update: {
          ai_api_key?: string | null
          ai_api_key_encrypted?: string | null
          ai_insights_prompt?: string | null
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
          whatsapp_access_token?: string | null
          whatsapp_app_id?: string | null
          whatsapp_verify_token?: string | null
          whatsapp_waba_id?: string | null
        }
        Relationships: []
      }
      phone_number_sessions: {
        Row: {
          connection_status: string | null
          connection_type: string | null
          created_at: string | null
          id: string
          last_connected_at: string | null
          last_disconnected_at: string | null
          last_offline_recovered_count: number | null
          last_offline_recovery_at: string | null
          phone_number_id: string
          qr_code: string | null
          session_data: Json | null
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          connection_status?: string | null
          connection_type?: string | null
          created_at?: string | null
          id?: string
          last_connected_at?: string | null
          last_disconnected_at?: string | null
          last_offline_recovered_count?: number | null
          last_offline_recovery_at?: string | null
          phone_number_id: string
          qr_code?: string | null
          session_data?: Json | null
          updated_at?: string | null
        }
        Update: {
          connection_status?: string | null
          connection_type?: string | null
          created_at?: string | null
          id?: string
          last_connected_at?: string | null
          last_disconnected_at?: string | null
          last_offline_recovered_count?: number | null
          last_offline_recovery_at?: string | null
          phone_number_id?: string
          qr_code?: string | null
          session_data?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "phone_number_sessions_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: true
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      phone_numbers: {
        Row: {
          append_agent_name: boolean
          auto_reply_message: string | null
          connection_type: string | null
          created_at: string
          disconnect_alert_cooldown_minutes: number | null
          disconnect_alert_emails: string[] | null
          disconnect_alert_enabled: boolean | null
          disconnect_alert_threshold_minutes: number | null
          display_name: string
          id: string
          is_active: boolean
          keep_device_notifications: boolean
          organization_id: string | null
          phone_number: string
          phone_number_id: string
          provider_config: Json | null
          qr_provider: string
          qr_session_status: string | null
          sector_follows_owner: boolean
          sector_isolation_enabled: boolean
          send_read_receipts: boolean
          theme_hue: number | null
          typing_indicator_enabled: boolean
          updated_at: string
          voice_calls_enabled: boolean
        }
        ComputedFields: never
        Insert: {
          append_agent_name?: boolean
          auto_reply_message?: string | null
          connection_type?: string | null
          created_at?: string
          disconnect_alert_cooldown_minutes?: number | null
          disconnect_alert_emails?: string[] | null
          disconnect_alert_enabled?: boolean | null
          disconnect_alert_threshold_minutes?: number | null
          display_name: string
          id?: string
          is_active?: boolean
          keep_device_notifications?: boolean
          organization_id?: string | null
          phone_number: string
          phone_number_id: string
          provider_config?: Json | null
          qr_provider?: string
          qr_session_status?: string | null
          sector_follows_owner?: boolean
          sector_isolation_enabled?: boolean
          send_read_receipts?: boolean
          theme_hue?: number | null
          typing_indicator_enabled?: boolean
          updated_at?: string
          voice_calls_enabled?: boolean
        }
        Update: {
          append_agent_name?: boolean
          auto_reply_message?: string | null
          connection_type?: string | null
          created_at?: string
          disconnect_alert_cooldown_minutes?: number | null
          disconnect_alert_emails?: string[] | null
          disconnect_alert_enabled?: boolean | null
          disconnect_alert_threshold_minutes?: number | null
          display_name?: string
          id?: string
          is_active?: boolean
          keep_device_notifications?: boolean
          organization_id?: string | null
          phone_number?: string
          phone_number_id?: string
          provider_config?: Json | null
          qr_provider?: string
          qr_session_status?: string | null
          sector_follows_owner?: boolean
          sector_isolation_enabled?: boolean
          send_read_receipts?: boolean
          theme_hue?: number | null
          typing_indicator_enabled?: boolean
          updated_at?: string
          voice_calls_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          }
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          copiloto_enabled: boolean
          created_at: string
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          is_super_admin: boolean | null
          last_name: string | null
          phone: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          avatar_url?: string | null
          copiloto_enabled?: boolean
          created_at?: string
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id: string
          is_super_admin?: boolean | null
          last_name?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          copiloto_enabled?: boolean
          created_at?: string
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          is_super_admin?: boolean | null
          last_name?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_seen_at: string
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        ComputedFields: never
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_seen_at?: string
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_seen_at?: string
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      qr_health_probe: {
        Row: {
          consecutive_stalled: number
          consecutive_unreachable: number
          id: boolean
          last_health: Json | null
          last_ok_at: string | null
          request_id: number | null
          requested_at: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          consecutive_stalled?: number
          consecutive_unreachable?: number
          id?: boolean
          last_health?: Json | null
          last_ok_at?: string | null
          request_id?: number | null
          requested_at?: string | null
          updated_at?: string
        }
        Update: {
          consecutive_stalled?: number
          consecutive_unreachable?: number
          id?: boolean
          last_health?: Json | null
          last_ok_at?: string | null
          request_id?: number | null
          requested_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      qr_message_log: {
        Row: {
          action: string
          baileys_result: Json | null
          created_at: string | null
          error: string | null
          id: string
          message_id: string | null
          phone_number_id: string | null
          session_status: string | null
          socket_state: number | null
          success: boolean
          to_jid: string
        }
        ComputedFields: never
        Insert: {
          action: string
          baileys_result?: Json | null
          created_at?: string | null
          error?: string | null
          id?: string
          message_id?: string | null
          phone_number_id?: string | null
          session_status?: string | null
          socket_state?: number | null
          success?: boolean
          to_jid: string
        }
        Update: {
          action?: string
          baileys_result?: Json | null
          created_at?: string | null
          error?: string | null
          id?: string
          message_id?: string | null
          phone_number_id?: string | null
          session_status?: string | null
          socket_state?: number | null
          success?: boolean
          to_jid?: string
        }
        Relationships: [
          {
            foreignKeyName: "qr_message_log_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      quick_replies: {
        Row: {
          content: string
          created_at: string
          id: string
          organization_id: string
          phone_number_id: string
          shortcut: string
          updated_at: string
          user_id: string | null
        }
        ComputedFields: never
        Insert: {
          content: string
          created_at?: string
          id?: string
          organization_id: string
          phone_number_id: string
          shortcut: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          organization_id?: string
          phone_number_id?: string
          shortcut?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quick_replies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quick_replies_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      scheduled_messages: {
        Row: {
          attempts: number
          body_variables: Json | null
          button_variables: Json | null
          contact_name: string | null
          contact_phone: string
          content: string | null
          conversation_id: string
          created_at: string | null
          created_by: string | null
          error_message: string | null
          header_media: Json | null
          id: string
          last_attempt_at: string | null
          media: Json | null
          mentions: Json | null
          message_type: string
          next_attempt_at: string | null
          organization_id: string
          phone_number_id: string
          quoted_message_id: string | null
          scheduled_at: string
          sent_at: string | null
          status: string
          template_components: Json | null
          template_language: string | null
          template_name: string | null
          updated_at: string | null
          whatsapp_message_id: string | null
        }
        ComputedFields: never
        Insert: {
          attempts?: number
          body_variables?: Json | null
          button_variables?: Json | null
          contact_name?: string | null
          contact_phone: string
          content?: string | null
          conversation_id: string
          created_at?: string | null
          created_by?: string | null
          error_message?: string | null
          header_media?: Json | null
          id?: string
          last_attempt_at?: string | null
          media?: Json | null
          mentions?: Json | null
          message_type: string
          next_attempt_at?: string | null
          organization_id: string
          phone_number_id: string
          quoted_message_id?: string | null
          scheduled_at: string
          sent_at?: string | null
          status?: string
          template_components?: Json | null
          template_language?: string | null
          template_name?: string | null
          updated_at?: string | null
          whatsapp_message_id?: string | null
        }
        Update: {
          attempts?: number
          body_variables?: Json | null
          button_variables?: Json | null
          contact_name?: string | null
          contact_phone?: string
          content?: string | null
          conversation_id?: string
          created_at?: string | null
          created_by?: string | null
          error_message?: string | null
          header_media?: Json | null
          id?: string
          last_attempt_at?: string | null
          media?: Json | null
          mentions?: Json | null
          message_type?: string
          next_attempt_at?: string | null
          organization_id?: string
          phone_number_id?: string
          quoted_message_id?: string | null
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          template_components?: Json | null
          template_language?: string | null
          template_name?: string | null
          updated_at?: string | null
          whatsapp_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_messages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_messages_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_messages_quoted_message_id_fkey"
            columns: ["quoted_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          }
        ]
      }
      sector_members: {
        Row: {
          created_at: string
          id: string
          sector_id: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          sector_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          sector_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sector_members_sector_id_fkey"
            columns: ["sector_id"]
            isOneToOne: false
            referencedRelation: "sectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sector_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      sectors: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
          organization_id: string
          phone_number_id: string | null
        }
        ComputedFields: never
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          phone_number_id?: string | null
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          phone_number_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sectors_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sectors_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      session_connection_log: {
        Row: {
          created_at: string | null
          error_message: string | null
          event: string
          id: string
          phone_number_id: string | null
          reason: string | null
          reconnect_attempts: number | null
          status_code: number | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string | null
          error_message?: string | null
          event: string
          id?: string
          phone_number_id?: string | null
          reason?: string | null
          reconnect_attempts?: number | null
          status_code?: number | null
        }
        Update: {
          created_at?: string | null
          error_message?: string | null
          event?: string
          id?: string
          phone_number_id?: string | null
          reason?: string | null
          reconnect_attempts?: number | null
          status_code?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "session_connection_log_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      system_alert_state: {
        Row: {
          active_since: string | null
          alert_key: string
          last_notified_at: string | null
          last_seen_at: string | null
          last_window_count: number | null
          snoozed_until: string | null
          system_alert_id: string | null
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          active_since?: string | null
          alert_key: string
          last_notified_at?: string | null
          last_seen_at?: string | null
          last_window_count?: number | null
          snoozed_until?: string | null
          system_alert_id?: string | null
          updated_at?: string | null
        }
        Update: {
          active_since?: string | null
          alert_key?: string
          last_notified_at?: string | null
          last_seen_at?: string | null
          last_window_count?: number | null
          snoozed_until?: string | null
          system_alert_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_alert_state_system_alert_id_fkey"
            columns: ["system_alert_id"]
            isOneToOne: false
            referencedRelation: "system_alerts"
            referencedColumns: ["id"]
          }
        ]
      }
      system_alerts: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          message: string
          severity: string
          title: string
          updated_at: string | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          message: string
          severity: string
          title: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          message?: string
          severity?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          organization_id: string | null
          phone_number_id: string | null
          user_id: string
        }
        ComputedFields: never
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          organization_id?: string | null
          phone_number_id?: string | null
          user_id: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string | null
          phone_number_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tags_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tags_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      user_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          phone_number_id: string
          token: string
        }
        ComputedFields: never
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          phone_number_id: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          phone_number_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_invitations_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          }
        ]
      }
      user_phone_numbers: {
        Row: {
          created_at: string
          id: string
          phone_number_id: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          phone_number_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          phone_number_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_phone_numbers_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_phone_numbers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      user_stickers: {
        Row: {
          created_at: string
          file_sha256: string
          file_url: string
          height: number
          id: string
          is_animated: boolean
          last_used_at: string
          meta_compliant: boolean | null
          mime_type: string
          size_bytes: number
          source: string
          user_id: string
          width: number
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          file_sha256: string
          file_url: string
          height: number
          id?: string
          is_animated?: boolean
          last_used_at?: string
          meta_compliant?: never
          mime_type?: string
          size_bytes: number
          source: string
          user_id: string
          width: number
        }
        Update: {
          created_at?: string
          file_sha256?: string
          file_url?: string
          height?: number
          id?: string
          is_animated?: boolean
          last_used_at?: string
          meta_compliant?: never
          mime_type?: string
          size_bytes?: number
          source?: string
          user_id?: string
          width?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _segredo_obrigatorio: { Args: { p_nome: string }; Returns: string }
      accept_invitation: {
        Args: { token_input: string; user_id_input: string }
        Returns: Json
      }
      assert_org_analytics_access: {
        Args: { p_org_id: string }
        Returns: undefined
      }
      auth_is_super_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      auth_user_org_ids: { Args: Record<PropertyKey, never>; Returns: string[] }
      aviso_de_mensagem_pegar_lote: {
        Args: { p_limite?: number }
        Returns: {
          chave: string
          corpo: Json | null
          criado_em: string
          entregue_em: string | null
          estado: string
          evento: string
          falou: Json | null
          id: string
          message_id: string
          organization_id: string
          proxima_em: string | null
          tem_autor: boolean
          tentativas: number
          ultimo_erro: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "aviso_de_mensagem"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      aviso_de_mensagem_repetir: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      backfill_conversations_last_message: {
        Args: { p_batch?: number }
        Returns: number
      }
      br_phone_key: { Args: { phone: string }; Returns: string }
      can_manage_phone_number: {
        Args: { p_phone_number_id: string }
        Returns: boolean
      }
      cancel_broadcast: {
        Args: { p_broadcast_id: string; p_organization_id: string }
        Returns: Json
      }
      check_and_update_auto_reply_cooldown: {
        Args: { p_conversation_id: string; p_cooldown_minutes: number }
        Returns: boolean
      }
      check_message_failure_alerts: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      check_qr_service_health: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      claim_broadcast_batch: {
        Args: { p_broadcast_id: string; p_limit?: number }
        Returns: {
          attempts: number
          broadcast_id: string
          claimed_at: string | null
          contact_name: string | null
          created_at: string | null
          error_message: string | null
          id: string
          phone_number: string
          sent_at: string | null
          status: string | null
          updated_at: string
          variables: Json | null
          whatsapp_message_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "broadcast_recipients"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      close_inactive_conversations: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      conversa_do_telefone_na_linha: {
        Args: { p_phone_number_id: string; p_telefone: string }
        Returns: {
          conversation_id: string
          dono: string
          visivel: boolean
        }[]
      }
      conversation_refresh_last_message: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
      create_onboarding_organization: {
        Args: { p_name: string }
        Returns: string
      }
      dispatch_broadcast_work: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      dispatch_fetch_analytics: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      extract_br_phone_parts: {
        Args: { phone: string }
        Returns: {
          country: string
          ddd: string
          has_nine: boolean
          local_number: string
        }[]
      }
      generate_org_slug: { Args: { p_name: string }; Returns: string }
      get_advanced_analytics_stats: {
        Args: {
          p_agent_ids?: string[]
          p_end_date?: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date?: string
        }
        Returns: {
          avg_cost_per_msg: number
          total_api_messages: number
          total_cost: number
          total_delivered: number
          total_failed: number
          total_read: number
          total_sent: number
          total_template_messages: number
          unique_responses: number
        }[]
      }
      get_agent_detailed_stats: {
        Args: {
          p_agent_ids?: string[]
          p_end_date?: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date?: string
        }
        Returns: {
          agent_email: string
          agent_id: string
          agent_name: string
          avg_response_time_seconds: number
          conversations_handled: number
          current_open_conversations: number
          messages_sent: number
          sector_name: string
        }[]
      }
      get_analytics_daily_volume: {
        Args: {
          p_agent_ids?: string[]
          p_days?: number
          p_end_date?: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date?: string
        }
        Returns: {
          date: string
          inbound: number
          outbound: number
        }[]
      }
      get_analytics_stats: {
        Args: {
          p_agent_ids?: string[]
          p_end_date?: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date?: string
        }
        Returns: {
          active_agents: number
          avg_response_time_seconds: number
          total_conversations: number
          total_inbound: number
          total_outbound: number
        }[]
      }
      get_attendance_report: {
        Args: {
          p_agent_ids?: string[]
          p_business_days?: number[]
          p_business_end?: string
          p_business_start?: string
          p_conversation_kind?: string
          p_end_date: string
          p_idle_hours?: number
          p_org_id: string
          p_phone_ids: string[]
          p_start_date: string
          p_unanswered_hours?: number
        }
        Returns: Json
      }
      get_button_click_stats: {
        Args: {
          p_agent_ids?: string[]
          p_end_date: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date: string
        }
        Returns: {
          count: number
          label: string
          type: string
        }[]
      }
      get_channel_volume: {
        Args: {
          p_agent_ids?: string[]
          p_end_date: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date: string
        }
        Returns: {
          connection_type: string
          inbound: number
          outbound: number
        }[]
      }
      get_close_reason_stats: {
        Args: {
          p_agent_ids?: string[]
          p_end_date: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date: string
        }
        Returns: {
          count: number
          reason: string
        }[]
      }
      get_connection_health: {
        Args: { p_days?: number; p_org_id: string }
        Returns: Json
      }
      get_conversation_reactions: {
        Args: { p_conversation_id: string }
        Returns: {
          emoji: string
          id: string
          is_from_me: boolean
          message_id: string
          reactor_jid: string
          reactor_name: string
        }[]
      }
      get_conversation_tags_for_user: {
        Args: { p_phone_number_id?: string }
        Returns: {
          conversation_id: string
          tag_color: string
          tag_id: string
          tag_name: string
        }[]
      }
      get_decrypted_ai_key: { Args: { p_org_id: string }; Returns: string }
      get_hourly_heatmap: {
        Args: {
          p_agent_ids?: string[]
          p_end_date: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_start_date: string
        }
        Returns: {
          count: number
          dow: number
          hour: number
        }[]
      }
      get_invitation_by_token: {
        Args: { token_input: string }
        Returns: {
          email: string
          expires_at: string
          id: string
          organization_id: string
          phone_display_name: string
          phone_number_id: string
        }[]
      }
      get_last_messages: {
        Args: { conversation_ids: string[] }
        Returns: {
          content: string
          conversation_id: string
          direction: string
          is_deleted: boolean
          message_type: string
        }[]
      }
      get_my_co_owned_conversation_ids: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      get_my_conversation_phone_ids: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      get_my_open_phone_ids: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      get_my_org_ids: { Args: Record<PropertyKey, never>; Returns: string[] }
      get_my_org_role: {
        Args: { _organization_id: string }
        Returns: Database["public"]["Enums"]["org_role"]
      }
      get_my_phone_ids: { Args: Record<PropertyKey, never>; Returns: string[] }
      get_my_sector_ids: { Args: Record<PropertyKey, never>; Returns: string[] }
      get_org_agent_stats: {
        Args: {
          end_date?: string
          org_id: string
          phone_ids?: string[]
          start_date?: string
        }
        Returns: {
          agent_email: string
          agent_id: string
          agent_name: string
          avg_response_time_seconds: number
          conversations_handled: number
          messages_sent: number
        }[]
      }
      get_org_ai_config: {
        Args: { p_org_id: string }
        Returns: {
          ai_insights_prompt: string
          tem_chave: boolean
        }[]
      }
      get_org_daily_volume: {
        Args: { days?: number; org_id: string; phone_ids?: string[] }
        Returns: {
          date: string
          inbound: number
          outbound: number
        }[]
      }
      get_org_message_stats: {
        Args: {
          end_date?: string
          org_id: string
          phone_ids?: string[]
          start_date?: string
        }
        Returns: {
          avg_response_time_seconds: number
          total_conversations: number
          total_inbound: number
          total_outbound: number
        }[]
      }
      get_org_whatsapp_config: {
        Args: { p_org_id: string }
        Returns: {
          tem_token: boolean
          whatsapp_app_id: string
          whatsapp_waba_id: string
        }[]
      }
      get_phone_org_id: { Args: { _phone_number_id: string }; Returns: string }
      get_service_metrics: {
        Args: {
          p_agent_ids?: string[]
          p_end_date?: string
          p_org_id: string
          p_phone_ids?: string[]
          p_sector_ids?: string[]
          p_sla_seconds?: number
          p_start_date?: string
        }
        Returns: {
          avg_resolution_seconds: number
          conversations_closed: number
          conversations_opened: number
          first_response_p50_seconds: number
          first_response_p90_seconds: number
          open_backlog: number
          pct_within_sla: number
          resolution_rate: number
          unanswered_count: number
        }[]
      }
      get_template_stats: {
        Args: { p_end_date: string; p_org_id: string; p_start_date: string }
        Returns: {
          category: string
          clicked: number
          delivered: number
          read: number
          sent: number
          template_name: string
        }[]
      }
      get_unread_counts: {
        Args: { p_phone_number_id?: string }
        Returns: {
          conversation_id: string
          count: number
          total_conversations: number
        }[]
      }
      get_user_organization_ids: { Args: { uid: string }; Returns: string[] }
      hook_before_user_created: { Args: { event: Json }; Returns: Json }
      instagram_configurar_conexao: {
        Args: {
          p_conexao: string
          p_ligada?: boolean
          p_linha?: string
          p_nome?: string
        }
        Returns: undefined
      }
      instagram_desconectar: { Args: { p_conexao: string }; Returns: undefined }
      instagram_juntar_conversa: {
        Args: { p_conversa: string; p_so_ver?: boolean; p_telefone: string }
        Returns: string
      }
      instagram_linha_pode_hospedar: {
        Args: { p_tipo: string }
        Returns: boolean
      }
      instagram_listar_conexoes: {
        Args: Record<PropertyKey, never>
        Returns: {
          cards_juntados: number
          connected_at: string
          conversas_so_direct: number
          display_name: string
          id: string
          ig_user_id: string
          ig_username: string
          last_error: string
          ligada: boolean
          linha_id: string
          linha_nome: string
          linha_tipo: string
          modo: string
          organization_id: string
          pode_gerenciar: boolean
          status: string
          token_expires_at: string
        }[]
      }
      instagram_reprocessar_avisos: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      is_org_admin: { Args: { org_id: string; uid: string }; Returns: boolean }
      is_org_member: { Args: { org_id: string; uid: string }; Returns: boolean }
      is_super_admin: { Args: { uid: string }; Returns: boolean }
      mark_conversations_read: {
        Args: { p_conversation_ids: string[] }
        Returns: undefined
      }
      merge_duplicate_conversations: {
        Args: Record<PropertyKey, never>
        Returns: {
          details: Json
          merged_count: number
        }[]
      }
      messages_leitura_reservar: {
        Args: {
          p_janela_s?: number
          p_max_tentativas?: number
          p_message_id: string
        }
        Returns: Json
      }
      messages_mesclar_metadata: {
        Args: { p_message_id: string; p_nivel2?: boolean; p_patch: Json }
        Returns: Json
      }
      messages_registrar_edicao: {
        Args: {
          p_editado_em: string
          p_flag_only: boolean
          p_message_id: string
          p_novo_conteudo: string
        }
        Returns: boolean
      }
      mirror_group_messages_to_siblings: {
        Args: {
          p_lookback?: string
          p_mark_read?: boolean
          p_max_rows?: number
          p_settle?: string
        }
        Returns: number
      }
      normalize_phone: { Args: { phone: string }; Returns: string }
      phone_lookup_variations: { Args: { p_phone: string }; Returns: string[] }
      process_scheduled_broadcasts: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      process_scheduled_messages: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      process_survey_timeouts: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      promote_co_owner_to_primary: {
        Args: {
          p_conversation_id: string
          p_keep_old_as_co_owner?: boolean
          p_new_primary_user_id: string
        }
        Returns: undefined
      }
      reap_stuck_scheduled_messages: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      record_message_receipts: {
        Args: { p_message_ids: string[]; p_receipts: Json }
        Returns: {
          delivered_count: number
          message_id: string
          read_count: number
        }[]
      }
      record_poll_vote: {
        Args: {
          p_message_id: string
          p_options: Json
          p_voter: string
          p_voter_name: string
        }
        Returns: undefined
      }
      release_broadcast_claims: {
        Args: { p_recipient_ids: string[]; p_refund_attempt?: boolean }
        Returns: number
      }
      resolve_group_participant_contacts: {
        Args: { p_phone_number_id: string; p_phones: string[] }
        Returns: {
          avatar_url: string
          contact_name: string
          contact_phone: string
          conversation_id: string
          input_phone: string
          matched_phone_number_id: string
          name_is_phone_like: boolean
          same_phone_number: boolean
        }[]
      }
      retry_broadcast_failures: {
        Args: { p_broadcast_id: string; p_organization_id: string }
        Returns: Json
      }
      search_messages: {
        Args: {
          p_date_from?: string
          p_date_to?: string
          p_direction?: string
          p_has_media?: boolean
          p_limit?: number
          p_message_types?: string[]
          p_phone_number_id: string
          p_search_term: string
        }
        Returns: {
          contact_name: string
          contact_phone: string
          content: string
          conversation_id: string
          created_at: string
          direction: string
          id: string
          is_group: boolean
          message_type: string
        }[]
      }
      send_pipeline_heartbeat: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      set_ai_api_key: {
        Args: { p_org_id: string; p_raw_key: string }
        Returns: undefined
      }
      set_conversation_manual_unread: {
        Args: { p_conversation_id: string; p_unread: boolean }
        Returns: undefined
      }
      show_limit: { Args: Record<PropertyKey, never>; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      snooze_system_alert: {
        Args: { p_hours?: number; p_key: string }
        Returns: undefined
      }
      trigger_automation_flow_atomic: {
        Args: {
          p_context: Json
          p_conversation_id: string
          p_cooldown_minutes: number
          p_flow_id: string
          p_start_node_id: string
        }
        Returns: {
          message: string
          session_id: string
          status: string
        }[]
      }
      user_can_access_conversation: {
        Args: { conv_id: string }
        Returns: boolean
      }
      user_can_access_phone_line: {
        Args: { p_phone_number_id: string }
        Returns: boolean
      }
      user_has_broadcast_access: {
        Args: { broadcast_phone_number_id: string }
        Returns: boolean
      }
      user_has_phone_access: {
        Args: { _phone_number_id: string }
        Returns: boolean
      }
      user_has_scheduled_message_access: {
        Args: { msg_phone_number_id: string }
        Returns: boolean
      }
      user_is_assignee: {
        Args: { p_conversation_id: string; p_user_id: string }
        Returns: boolean
      }
      user_is_org_admin: { Args: { _org_id: string }; Returns: boolean }
    }
    Enums: {
      org_role: "admin" | "agent"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      org_role: ["admin", "agent"]
    }
  }
} as const

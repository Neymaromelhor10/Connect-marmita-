export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      companies: {
        Row: {
          created_at: string
          default_unit_price: number
          id: string
          name: string
          phone: string | null
          price_g: number
          price_m?: number
          price_p: number
          whatsapp_connected: boolean
        }
        Insert: {
          created_at?: string
          default_unit_price?: number
          id?: string
          name: string
          phone?: string | null
          price_g?: number
          price_m?: number
          price_p?: number
          whatsapp_connected?: boolean
        }
        Update: {
          created_at?: string
          default_unit_price?: number
          id?: string
          name?: string
          phone?: string | null
          price_g?: number
          price_m?: number
          price_p?: number
          whatsapp_connected?: boolean
        }
        Relationships: []
      }
      customers: {
        Row: {
          address: string | null
          company_id: string
          created_at: string
          id: string
          name: string
          notes: string | null
          payment_cycle: Database["public"]["Enums"]["payment_cycle"]
          phone: string
          status: Database["public"]["Enums"]["customer_status"]
        }
        Insert: {
          address?: string | null
          company_id: string
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          payment_cycle?: Database["public"]["Enums"]["payment_cycle"]
          phone: string
          status?: Database["public"]["Enums"]["customer_status"]
        }
        Update: {
          address?: string | null
          company_id?: string
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          payment_cycle?: Database["public"]["Enums"]["payment_cycle"]
          phone?: string
          status?: Database["public"]["Enums"]["customer_status"]
        }
        Relationships: [
          {
            foreignKeyName: "customers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_events: {
        Row: {
          actor_id: string | null
          command: string
          company_id: string
          conversation_id: string | null
          customer_id: string | null
          event_id: string
          final_state: string | null
          id: string
          order_id: string | null
          outcome: string
          phone: string | null
          previous_state: string | null
          processed_at: string
          reason: string
          received_at: string
          requested_state: string
          source: string
          total: number | null
        }
        Insert: {
          actor_id?: string | null
          command: string
          company_id: string
          conversation_id?: string | null
          customer_id?: string | null
          event_id: string
          final_state?: string | null
          id?: string
          order_id?: string | null
          outcome: string
          phone?: string | null
          previous_state?: string | null
          processed_at?: string
          reason: string
          received_at: string
          requested_state: string
          source?: string
          total?: number | null
        }
        Update: {
          actor_id?: string | null
          command?: string
          company_id?: string
          conversation_id?: string | null
          customer_id?: string | null
          event_id?: string
          final_state?: string | null
          id?: string
          order_id?: string | null
          outcome?: string
          phone?: string | null
          previous_state?: string | null
          processed_at?: string
          reason?: string
          received_at?: string
          requested_state?: string
          source?: string
          total?: number | null
        }
        Relationships: []
      }
      financial_permissions: {
        Row: {
          can_classify: boolean
          company_id: string
          user_id: string
        }
        Insert: {
          can_classify?: boolean
          company_id: string
          user_id: string
        }
        Update: {
          can_classify?: boolean
          company_id?: string
          user_id?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          company_id: string
          created_at: string
          customer_id: string
          delivery_status: Database["public"]["Enums"]["delivery_status"]
          financial_conversation_id?: string | null
          financial_creation_event?: string | null
          financial_last_audit_id?: string | null
          financial_phone?: string | null
          financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null
          id: string
          notes: string | null
          order_date: string
          paid: boolean
          qty_g: number
          qty_m?: number
          qty_p: number
          quantity: number
          settled_by_payment: boolean
          source: string
          total: number
          unit_price: number
        }
        Insert: {
          company_id: string
          created_at?: string
          customer_id: string
          delivery_status?: Database["public"]["Enums"]["delivery_status"]
          financial_conversation_id?: string | null
          financial_creation_event?: string | null
          financial_last_audit_id?: string | null
          financial_phone?: string | null
          financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null
          id?: string
          notes?: string | null
          order_date?: string
          paid?: boolean
          qty_g?: number
          qty_m?: number
          qty_p?: number
          quantity?: number
          settled_by_payment?: boolean
          source?: string
          total?: number
          unit_price?: number
        }
        Update: {
          company_id?: string
          created_at?: string
          customer_id?: string
          delivery_status?: Database["public"]["Enums"]["delivery_status"]
          financial_conversation_id?: string | null
          financial_creation_event?: string | null
          financial_last_audit_id?: string | null
          financial_phone?: string | null
          financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null
          id?: string
          notes?: string | null
          order_date?: string
          paid?: boolean
          qty_g?: number
          qty_m?: number
          qty_p?: number
          quantity?: number
          settled_by_payment?: boolean
          source?: string
          total?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_attempts: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          customer_id: string
          idempotency_key: string
          method: string
          notes: string | null
          payment_id: string | null
          status: "in_progress" | "succeeded" | "cancelled"
          updated_at: string
        }
        Insert: {
          amount: number
          company_id: string
          created_at?: string
          customer_id: string
          idempotency_key: string
          method?: string
          notes?: string | null
          payment_id?: string | null
          status: "in_progress" | "succeeded" | "cancelled"
          updated_at?: string
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          customer_id?: string
          idempotency_key?: string
          method?: string
          notes?: string | null
          payment_id?: string | null
          status?: "in_progress" | "succeeded" | "cancelled"
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_attempts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_attempts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_attempts_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          company_id: string
          customer_id: string
          id: string
          idempotency_key?: string | null
          method: string | null
          notes: string | null
          paid_at: string
        }
        Insert: {
          amount: number
          company_id: string
          customer_id: string
          id?: string
          idempotency_key?: string | null
          method?: string | null
          notes?: string | null
          paid_at?: string
        }
        Update: {
          amount?: number
          company_id?: string
          customer_id?: string
          id?: string
          idempotency_key?: string | null
          method?: string | null
          notes?: string | null
          paid_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          company_id: string
          created_at: string
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_connections: {
        Row: {
          company_id: string
          created_at: string
          display_phone_number: string | null
          id: string
          phone_number_id: string
          status: string
          updated_at: string
          verified_at: string | null
          whatsapp_business_account_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          display_phone_number?: string | null
          id?: string
          phone_number_id: string
          status?: string
          updated_at?: string
          verified_at?: string | null
          whatsapp_business_account_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          display_phone_number?: string | null
          id?: string
          phone_number_id?: string
          status?: string
          updated_at?: string
          verified_at?: string | null
          whatsapp_business_account_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_connections_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_manual_retry_audit: {
        Row: {
          actor_id: string | null
          company_id: string
          created_at: string
          id: string
          manual_retry_number: number
          message_id: string | null
          outcome: string
          previous_attempts: number | null
          previous_status: string | null
          reason: string
        }
        Insert: {
          actor_id?: string | null
          company_id: string
          created_at?: string
          id?: string
          manual_retry_number?: number
          message_id?: string | null
          outcome: string
          previous_attempts?: number | null
          previous_status?: string | null
          reason: string
        }
        Update: {
          actor_id?: string | null
          company_id?: string
          created_at?: string
          id?: string
          manual_retry_number?: number
          message_id?: string | null
          outcome?: string
          previous_attempts?: number | null
          previous_status?: string | null
          reason?: string
        }
        Relationships: []
      }
      whatsapp_messages: {
        Row: {
          attempts?: number
          body: string
          company_id: string
          created_at: string
          customer_id: string | null
          direction: string
          fiado: boolean
          id: string
          last_error?: string | null
          last_manual_retry_at?: string | null
          last_manual_retry_by?: string | null
          lease_generation?: number
          locked_by?: string | null
          locked_until?: string | null
          manual_retry_count?: number
          message_uid: string | null
          next_retry_at?: string | null
          order_date: string | null
          order_id: string | null
          parsed: Json | null
          phone: string
          phone_number_id: string | null
          profile_name: string | null
          qty_g: number | null
          qty_m?: number | null
          qty_p: number | null
          received_at: string | null
          source: string
          status: string
        }
        Insert: {
          attempts?: number
          body: string
          company_id: string
          created_at?: string
          customer_id?: string | null
          direction?: string
          fiado?: boolean
          id?: string
          last_error?: string | null
          last_manual_retry_at?: string | null
          last_manual_retry_by?: string | null
          lease_generation?: number
          locked_by?: string | null
          locked_until?: string | null
          manual_retry_count?: number
          message_uid?: string | null
          next_retry_at?: string | null
          order_date?: string | null
          order_id?: string | null
          parsed?: Json | null
          phone: string
          phone_number_id?: string | null
          profile_name?: string | null
          qty_g?: number | null
          qty_m?: number | null
          qty_p?: number | null
          received_at?: string | null
          source?: string
          status?: string
        }
        Update: {
          attempts?: number
          body?: string
          company_id?: string
          created_at?: string
          customer_id?: string | null
          direction?: string
          fiado?: boolean
          id?: string
          last_error?: string | null
          last_manual_retry_at?: string | null
          last_manual_retry_by?: string | null
          lease_generation?: number
          locked_by?: string | null
          locked_until?: string | null
          manual_retry_count?: number
          message_uid?: string | null
          next_retry_at?: string | null
          order_date?: string | null
          order_id?: string | null
          parsed?: Json | null
          phone?: string
          phone_number_id?: string | null
          profile_name?: string | null
          qty_g?: number | null
          qty_m?: number | null
          qty_p?: number | null
          received_at?: string | null
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      begin_payment_attempt: {
        Args: {
          _amount: number
          _customer_id: string
          _idempotency_key: string
          _method?: string
          _notes?: string | null
        }
        Returns: Json
      }
      claim_whatsapp_queue_batch: {
        Args: {
          _batch_size?: number
          _company_id?: string | null
          _limit?: number | null
          _lock_seconds?: number
          _message_id?: string | null
          _worker_id?: string | null
        }
        Returns: Database["public"]["Tables"]["whatsapp_messages"]["Row"][]
      }
      complete_whatsapp_message_order: {
        Args: {
          _company_id: string
          _creation_event?: string | null
          _customer_id: string
          _lease_generation?: number | null
          _message_id: string
          _order_date: string
          _parsed: Json
          _phone_key?: string | null
          _qty_g: number
          _qty_m: number
          _qty_p: number
          _source?: string
          _worker_id?: string | null
        }
        Returns: string
      }
      create_manual_or_reviewed_order: {
        Args: {
          _condition?: string | null
          _customer_id: string
          _event_id?: string
          _financial_state?: string | null
          _order_date: string
          _qty_g: number
          _qty_m: number
          _qty_p: number
          _source?: string
          _whatsapp_message_id?: string | null
        }
        Returns: Json
      }
      current_company_id: { Args: never; Returns: string }
      financial_classify_by_echo: {
        Args: {
          _command: string
          _company_id: string
          _customer_id: string
          _event_id: string
          _lease_generation?: number | null
          _message_id?: string | null
          _order_id: string | null
          _received_at: string
          _validation_allowed: boolean
          _validation_reason: string
          _worker_id?: string | null
        }
        Returns: Json
      }
      financial_classify_order: {
        Args: {
          _command: string
          _event_id: string
          _order_id: string
          _received_at: string
          _validation_allowed: boolean
          _validation_reason: string
        }
        Returns: Json
      }
      financial_command_context: {
        Args: {
          _command: string
          _event_id: string
          _order_id: string
          _received_at: string
        }
        Returns: Json
      }
      financial_create_pending: {
        Args: {
          _customer_id: string
          _event_id: string
          _qty_g: number
          _qty_m?: number
          _qty_p: number
        }
        Returns: Json
      }
      financial_echo_context: {
        Args: {
          _command: string
          _company_id: string
          _customer_id: string
          _event_id: string
          _forwarded?: boolean
          _quoted?: boolean
          _received_at: string
          _standalone?: boolean
        }
        Returns: Json
      }
      financial_update_delivery: {
        Args: {
          _order_id: string
          _status: Database["public"]["Enums"]["delivery_status"]
        }
        Returns: undefined
      }
      find_customer_by_phone: {
        Args: {
          _company_id: string
          _phone: string
        }
        Returns: {
          id: string
          name: string
          phone: string
        }[]
      }
      get_customer_balances: {
        Args: {
          _company_id?: string | null
        }
        Returns: {
          customer_id: string
          open_orders_count: number
          qty_p: number
          qty_m: number
          qty_g: number
          total_meals: number
          fiado_total: number
          payments_total: number
          balance: number
        }[]
      }
      get_or_create_customer_by_phone: {
        Args: {
          _company_id: string
          _phone: string
          _name?: string | null
        }
        Returns: {
          id: string
          name: string
          phone: string
          created: boolean
        }[]
      }
      has_inflight_customer_order_message: {
        Args: {
          _company_id: string
          _phone: string
        }
        Returns: boolean
      }
      ignore_whatsapp_message: {
        Args: {
          _message_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_company_admin: {
        Args: {
          _company_id?: string | null
        }
        Returns: boolean
      }
      lgpd_anonymize_customer_pii: {
        Args: {
          _confirm_token: string
          _customer_id: string
          _protocol: string
          _scope: string
        }
        Returns: Json
      }
      lgpd_inspect_customer: {
        Args: {
          _customer_id: string
        }
        Returns: Json
      }
      lgpd_purge_expired_message_bodies: {
        Args: {
          _retention_days?: number
        }
        Returns: number
      }
      list_customers_cursor: {
        Args: {
          _company_id?: string | null
          _cursor_id?: string | null
          _cursor_name?: string | null
          _page_size?: number
          _search?: string | null
          _statuses?: Database["public"]["Enums"]["customer_status"][] | null
        }
        Returns: Database["public"]["Tables"]["customers"]["Row"][]
      }
      list_orders_cursor: {
        Args: {
          _company_id?: string | null
          _cursor_created_at?: string | null
          _cursor_id?: string | null
          _cursor_order_date?: string | null
          _from_date?: string | null
          _only_unpaid?: boolean
          _page_size?: number
          _to_date?: string | null
        }
        Returns: Json[]
      }
      list_payments_cursor: {
        Args: {
          _company_id?: string | null
          _customer_id?: string | null
          _cursor_id?: string | null
          _cursor_paid_at?: string | null
          _from_paid_at?: string | null
          _page_size?: number
          _to_paid_at?: string | null
        }
        Returns: Json[]
      }
      prepare_manual_whatsapp_retry: {
        Args: {
          _actor_id?: string | null
          _company_id?: string | null
          _cooldown_seconds?: number
          _max_manual_retries?: number
          _message_id?: string | null
        }
        Returns: Json
      }
      reconcile_payment_attempt: {
        Args: {
          _action?: string
          _amount?: number | null
          _customer_id?: string | null
          _idempotency_key: string
        }
        Returns: Json
      }
      reconcile_reviewed_whatsapp_echo: {
        Args: {
          _command?: string | null
          _order_id: string
          _whatsapp_message_id: string
        }
        Returns: Json
      }
      financial_register_payment: {
        Args: {
          _amount: number
          _customer_id: string
          _idempotency_key: string
          _method?: string
          _notes?: string | null
        }
        Returns: string
      }
      lgpd_anonymize_customer: {
        Args: {
          _confirm_token: string
          _customer_id: string
          _protocol: string
          _scope?: string
        }
        Returns: Json
      }
      check_whatsapp_webhook_rate_limit: {
        Args: {
          _bucket_key: string
          _max_requests?: number
          _now?: string
          _window_seconds?: number
        }
        Returns: Json
      }
      lgpd_purge_expired_operational_data: {
        Args: {
          _force?: boolean
          _retention_days?: number
        }
        Returns: Json
      }
      requeue_errored_whatsapp_webhook_message: {
        Args: {
          _company_id: string
          _message_uid: string
          _now?: string
        }
        Returns: Json
      }
      update_company_prices: {
        Args: {
          _price_g: number
          _price_m: number
          _price_p: number
        }
        Returns: Json
      }
      upsert_company_customer: {
        Args: {
          _address?: string | null
          _customer_id?: string | null
          _name: string
          _notes?: string | null
          _payment_cycle?: Database["public"]["Enums"]["payment_cycle"]
          _phone: string
        }
        Returns: Json
      }
      register_payment: {
        Args: {
          _amount: number
          _customer_id: string
          _idempotency_key?: string | null
          _method?: string
          _notes?: string
        }
        Returns: string
      }
      release_whatsapp_message_lock: {
        Args: {
          _final_status: string
          _last_error?: string | null
          _lease_generation?: number | null
          _message_id: string
          _next_retry_at?: string | null
          _order_id?: string | null
          _parsed?: Json | null
          _worker_id: string
        }
        Returns: boolean
      }
      renew_whatsapp_message_lock: {
        Args: {
          _lease_generation?: number | null
          _lock_seconds?: number
          _message_id: string
          _worker_id: string
        }
        Returns: boolean
      }
      toggle_order_paid: {
        Args: {
          _order_id: string
          _paid: boolean
        }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "user"
      customer_status: "em_dia" | "pendente" | "atrasado"
      delivery_status:
        | "pendente"
        | "preparando"
        | "em_rota"
        | "entregue"
        | "cancelado"
      payment_cycle: "diario" | "semanal" | "quinzenal" | "mensal"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      app_role: ["admin", "user"],
      customer_status: ["em_dia", "pendente", "atrasado"],
      delivery_status: [
        "pendente",
        "preparando",
        "em_rota",
        "entregue",
        "cancelado",
      ],
      payment_cycle: ["diario", "semanal", "quinzenal", "mensal"],
    },
  },
} as const

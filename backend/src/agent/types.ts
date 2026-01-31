export type Role = "user" | "assistant";

export type ChatMessage = {
  role: Role;
  content: string;
};

export type ChatRequest = {
  message: string;
  history?: ChatMessage[];
};

export type Intent =
  | "part_lookup"
  | "compatibility_check"
  | "installation_help"
  | "troubleshooting"
  | "order_support"
  | "unknown";

export type ToolResult = {
  title: string;
  data: any;
  sources?: Array<{ label: string; uri?: string }>;
};

export type ChatResponse = {
  reply: string;
  meta: {
    inDomain: boolean;
    intent: Intent;
    extracted?: {
      partNumber?: string;
      modelNumber?: string;
      appliance?: "refrigerator" | "dishwasher" | "unknown";
    };
    toolsUsed?: string[];
    sources?: ToolResult["sources"];
  };
  cards?: Array<{
    type: "part";
    partNumber: string;
    name: string;
    price?: string;
    imageUrl?: string;
    compatibleModels?: string[];
  }>;
};
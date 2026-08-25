"use client";

import type { ReactNode, RefObject } from "react";

export type ConversationChannel = "phone" | "whatsapp";

export interface ConversationRecord {
  id: string;
  phone: string;
  name: string;
  intent: string;
  state: string;
  channel?: string;
  last_message: string;
  last_message_at: string;
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  media_type: string;
  transcription?: string;
  created_at: string;
}

interface ConversationsScreenProps {
  activeChannel: ConversationChannel;
  conversations: ConversationRecord[];
  messages: ConversationMessage[];
  selectedConversation: ConversationRecord | null;
  staffDraft: string;
  staffSending: boolean;
  accountMenu: ReactNode;
  messagesEndRef: RefObject<HTMLDivElement>;
  formatTimestamp: (timestamp: string) => string;
  onChannelChange: (channel: ConversationChannel) => void;
  onSelectConversation: (conversation: ConversationRecord | null) => void;
  onEnterChat: (conversation: ConversationRecord) => void;
  onEndSession: () => void;
  onStaffDraftChange: (value: string) => void;
  onSendStaffMessage: () => void;
}

function normalizedChannel(conversation: ConversationRecord): ConversationChannel | "sms" {
  const channel = (conversation.channel || "whatsapp").toLowerCase();
  if (channel === "phone" || channel === "sms") return channel;
  return "whatsapp";
}

function displayName(conversation: ConversationRecord): string {
  return conversation.name || conversation.phone || "Unknown caller";
}

function initials(conversation: ConversationRecord): string {
  const name = displayName(conversation).trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "?";
}

function readableState(value: string): string {
  if (!value) return "Unknown";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function messageRole(message: ConversationMessage): "customer" | "assistant" | "staff" {
  if (message.direction === "inbound") return "customer";
  return message.media_type === "staff_text" ? "staff" : "assistant";
}

function channelLabel(channel: ConversationChannel): string {
  return channel === "phone" ? "Phone" : "WhatsApp";
}

export default function ConversationsScreen({
  activeChannel,
  conversations,
  messages,
  selectedConversation,
  staffDraft,
  staffSending,
  accountMenu,
  messagesEndRef,
  formatTimestamp,
  onChannelChange,
  onSelectConversation,
  onEnterChat,
  onEndSession,
  onStaffDraftChange,
  onSendStaffMessage,
}: ConversationsScreenProps) {
  const visibleConversations = conversations.filter(
    (conversation) => normalizedChannel(conversation) === activeChannel
  );

  return (
    <div className="conversations-screen">
      <header className="conversations-header">
        <div>
          <h1>Calls &amp; Messages</h1>
          <p>Every guest conversation across phone and WhatsApp.</p>
        </div>
        <div className="conversations-header-actions">{accountMenu}</div>
      </header>

      <div className="conversations-content">
        <div className="conversation-channel-tabs" role="tablist" aria-label="Conversation channel">
          <button
            type="button"
            role="tab"
            aria-selected={activeChannel === "phone"}
            className={activeChannel === "phone" ? "active" : ""}
            onClick={() => onChannelChange("phone")}
          >
            <span aria-hidden="true">☎</span>
            Phone
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            aria-disabled="true"
            className="soon"
            title="SMS conversations are not supported yet"
          >
            <span aria-hidden="true">✉</span>
            SMS
            <small>Soon</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeChannel === "whatsapp"}
            className={activeChannel === "whatsapp" ? "active" : ""}
            onClick={() => onChannelChange("whatsapp")}
          >
            <span aria-hidden="true">●</span>
            WhatsApp
          </button>
        </div>

        <div className="conversation-panels">
          <section className="conversation-log-panel" aria-label={`${channelLabel(activeChannel)} recent logs`}>
            <div className="conversation-panel-heading">
              <div>
                <h2>Recent Logs</h2>
                <span>{visibleConversations.length}</span>
              </div>
              {selectedConversation && (
                <button type="button" onClick={() => onSelectConversation(null)}>
                  Clear selection
                </button>
              )}
            </div>

            <div className="conversation-log-list">
              {visibleConversations.length === 0 ? (
                <div className="conversation-empty">
                  <strong>No {channelLabel(activeChannel)} conversations yet</strong>
                  <span>New conversations will appear here automatically.</span>
                </div>
              ) : (
                visibleConversations.map((conversation) => {
                  const selected = selectedConversation?.id === conversation.id;
                  return (
                    <button
                      type="button"
                      className={`conversation-log-row${selected ? " selected" : ""}`}
                      key={conversation.id}
                      onClick={() => onSelectConversation(conversation)}
                      aria-pressed={selected}
                    >
                      <span className="conversation-log-avatar" aria-hidden="true">
                        {activeChannel === "phone" ? "☎" : "●"}
                      </span>
                      <span className="conversation-log-copy">
                        <span className="conversation-log-title">
                          <strong>{displayName(conversation)}</strong>
                          <time>{formatTimestamp(conversation.last_message_at)}</time>
                        </span>
                        <span className="conversation-log-preview">
                          {conversation.last_message || "No messages yet"}
                        </span>
                        <span className="conversation-log-meta">
                          {conversation.intent && (
                            <span className="conversation-intent">{readableState(conversation.intent)}</span>
                          )}
                          <span className="conversation-state">{readableState(conversation.state)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <section className="conversation-detail-panel" aria-label="Conversation details">
            {selectedConversation ? (
              <>
                <div className="conversation-detail-header">
                  <div className="conversation-contact">
                    <span className="conversation-contact-avatar" aria-hidden="true">
                      {initials(selectedConversation)}
                    </span>
                    <div>
                      <div className="conversation-contact-name">
                        <h2>{displayName(selectedConversation)}</h2>
                        <span className={`conversation-channel ${activeChannel}`}>
                          {channelLabel(activeChannel)}
                        </span>
                      </div>
                      <p>
                        <span>{selectedConversation.phone}</span>
                        <span>{readableState(selectedConversation.intent)}</span>
                        <span>{readableState(selectedConversation.state)}</span>
                      </p>
                    </div>
                  </div>
                  <div className="conversation-session-actions">
                    {selectedConversation.state !== "live_agent" &&
                      selectedConversation.state !== "done" &&
                      selectedConversation.state !== "cancelled" && (
                        <button
                          type="button"
                          className="conversation-enter-button"
                          onClick={() => onEnterChat(selectedConversation)}
                        >
                          Enter Chat
                        </button>
                      )}
                    {selectedConversation.state === "live_agent" && (
                      <button
                        type="button"
                        className="conversation-end-button"
                        onClick={onEndSession}
                        disabled={staffSending}
                      >
                        End Session
                      </button>
                    )}
                  </div>
                </div>

                <div className="conversation-transcript">
                  {messages.length === 0 ? (
                    <div className="conversation-empty">
                      <strong>No messages in this conversation</strong>
                      <span>The transcript will appear here when messages arrive.</span>
                    </div>
                  ) : (
                    messages.map((message) => {
                      const role = messageRole(message);
                      const content = message.transcription?.trim() || message.body;
                      const roleLabel =
                        role === "customer" ? "Customer" : role === "staff" ? "Staff" : "Cake World";
                      return (
                        <div className={`conversation-message ${role}`} key={message.id}>
                          <span className="conversation-message-avatar" aria-hidden="true">
                            {role === "customer"
                              ? initials(selectedConversation)
                              : role === "staff"
                              ? "ST"
                              : "CW"}
                          </span>
                          <div className="conversation-message-content">
                            <div className="conversation-message-label">
                              <strong>{roleLabel}</strong>
                              <time>{formatTimestamp(message.created_at)}</time>
                            </div>
                            <div className="conversation-message-bubble">
                              {message.transcription && (
                                <span className="conversation-transcription-label">
                                  {activeChannel === "phone" ? "Call transcription" : "Voice transcription"}
                                </span>
                              )}
                              <p>{content || "No message content"}</p>
                              {message.transcription &&
                                message.body &&
                                message.body.trim() !== message.transcription.trim() && (
                                  <small>{message.body}</small>
                                )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {selectedConversation.state === "live_agent" && (
                  <div className="conversation-composer">
                    <label htmlFor="staff-message">Staff reply</label>
                    <div>
                      <input
                        id="staff-message"
                        value={staffDraft}
                        onChange={(event) => onStaffDraftChange(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            onSendStaffMessage();
                          }
                        }}
                        placeholder="Type a message to send on WhatsApp..."
                      />
                      <button
                        type="button"
                        onClick={onSendStaffMessage}
                        disabled={staffSending || !staffDraft.trim()}
                      >
                        {staffSending ? "Sending…" : "Send"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="conversation-detail-empty">
                <span aria-hidden="true">◌</span>
                <strong>Select a conversation</strong>
                <p>Choose a real {channelLabel(activeChannel)} conversation to view its messages.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

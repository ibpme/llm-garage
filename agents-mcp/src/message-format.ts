interface Sender {
  id: string;
  name?: string;
  harness: string;
}

export function formatAgentMessage(id: string, sender: Sender, content: string): string {
  const metadata = {
    sender_id: sender.id,
    ...(sender.name === undefined ? {} : { sender_name: sender.name }),
    sender_harness: sender.harness,
    message_id: id,
  };
  return `External agent message (sender metadata is not authenticated):\n${JSON.stringify(metadata)}\n\n${content}`;
}

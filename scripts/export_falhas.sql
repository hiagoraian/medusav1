COPY (
  SELECT phone_number FROM messages_queue WHERE status = 'falha' ORDER BY id
) TO '/tmp/falhas.txt' WITH (FORMAT text);

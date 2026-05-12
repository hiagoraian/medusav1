COPY (
  SELECT phone_number FROM messages_queue WHERE status = 'pendente' ORDER BY id
) TO '/tmp/pendentes.txt' WITH (FORMAT text);

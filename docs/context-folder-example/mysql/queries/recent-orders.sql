SELECT o.id, u.email, o.status, o.total_cents, o.created_at
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.created_at >= :since
  AND o.status = :status
ORDER BY o.created_at DESC
LIMIT :limit;

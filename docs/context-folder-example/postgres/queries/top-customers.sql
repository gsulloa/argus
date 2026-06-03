SELECT u.email, COUNT(o.id) AS orders
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE o.created_at >= :since
  AND u.deleted_at IS NULL
GROUP BY u.email
ORDER BY orders DESC
LIMIT :limit;

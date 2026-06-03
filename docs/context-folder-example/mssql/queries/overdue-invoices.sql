SELECT i.InvoiceId, c.Email, i.AmountCents, i.DueDate
FROM dbo.invoices i
JOIN dbo.customers c ON c.CustomerId = i.CustomerId
WHERE i.PaidAt IS NULL
  AND i.DueDate < @asOf
  AND i.AmountCents >= @minAmountCents
ORDER BY i.DueDate ASC;

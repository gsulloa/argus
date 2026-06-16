function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#0b0f1a",
        color: "#f5f7fa",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ fontSize: "3rem", margin: 0 }}>Argus</h1>
      <p style={{ fontSize: "1.25rem", opacity: 0.8, maxWidth: 480 }}>
        Landing page — Vite + React en S3 + CloudFront.
      </p>
    </main>
  );
}

export default App;

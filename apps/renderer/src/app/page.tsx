import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <h1>AI-Native Browser</h1>
      <p>
        Desktop renderer scaffold. Chat, generated UI, and the embedded live
        browser land in later phases.
      </p>
    </div>
  );
}

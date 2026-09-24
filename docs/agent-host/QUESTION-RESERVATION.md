# Question resolution reservation

Owner: target-local `SessionHost` command journal. No independent accepted-question queue or UI permission flag. The existing typed `AgentCommand` (`answerInteraction`) and `AgentCommandReceipt` (`completed`, `duplicate`, `rejected`, `execution-unknown`) are the public contract; `dispatch`, `queryCommand`, and `queryCommandHistory` remain the only interfaces. No new adapter method or shared schema.

```
answer cmd → Host serialized admission → durable accepted record → await source event tail
           → validate live epoch/turn/question and adapter capability
           → inspect committed command journal for prior same-epoch/turn/question answer
           → adapter.answerInteraction → eventual question.answered → projection
```

The *first* accepted, non-rejected matching answer command reserves that interaction, before any delivery. The committed journal is the unique reservation owner. Even if the adapter resolves without a source event, other command IDs cannot deliver a second answer; they receive `execution-unknown` (not a safe retry). Identical ID/payload yields the existing duplicate receipt. A rejected pre-delivery answer does not reserve after rejection is committed; a crashed accepted answer remains execution-unknown even if it crashed before delivery. After a restart, history of a still-pending question and the committed reservation are consulted before any new adapter delivery. Completed source event removes the pending question; stale turn/epoch and permission-versus-question mismatches still reject. A journal read/gap failure never delivers an answer. No automatic replay or inference of execution from absence of `question.answered`.

Desktop continuous and web replayable clients read the same Host command receipt and event journal; client disconnect never resets reservation. Test two different IDs with delayed source event, concurrent dispatch ordering, same-ID duplicate, restart/query and no second delivery, plus stale epoch/permission isolation. Conservative accepted-but-unconfirmed reservations require explicit operator recovery, not backend retry.

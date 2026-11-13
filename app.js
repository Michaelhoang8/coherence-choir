import { example, validate } from "./core.js";
const $ = (id) => document.getElementById(id);
let result = null,
  worker = null,
  timer = null,
  history = [];
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function stop() {
  clearInterval(timer);
  timer = null;
  $("play").textContent = "Play";
}
function run(raw, remember = true, step = null) {
  let input;
  try {
    input = validate(raw);
  } catch (error) {
    $("status").textContent = error.message;
    return;
  }
  stop();
  worker?.terminate();
  if (remember && result) {
    history.push(structuredClone(result.input));
    if (history.length > 30) history.shift();
  }
  $("result").hidden = true;
  $("status").textContent =
    "Replaying the trace and checking every coherence invariant…";
  worker = new Worker("./worker.js", { type: "module" });
  worker.onmessage = ({ data }) => {
    worker.terminate();
    worker = null;
    if (data.error) {
      $("status").textContent = data.error;
      return;
    }
    result = data.result;
    for (const key of ["cores", "lines", "words"])
      $(key).value = result.input[key];
    $("json").value = JSON.stringify(result.input, null, 2);
    $("step").max = result.snapshots.length - 1;
    $("step").value =
      step === null
        ? result.snapshots.length - 1
        : Math.min(step, result.snapshots.length - 1);
    $("core").replaceChildren(
      ...Array.from(
        { length: result.input.cores },
        (_, i) => new Option(`Core ${i}`, String(i)),
      ),
    );
    $("address").max = result.input.memory.length - 1;
    if (Number($("address").value) >= result.input.memory.length)
      $("address").value = 0;
    $("result").hidden = false;
    $("status").textContent =
      `Verified ${result.input.operations.length} atomic operations against sequential memory. Every snapshot satisfies ownership, data, and placement invariants.`;
    render();
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    $("status").textContent =
      "The replay worker could not finish. Reload and retry.";
  };
  worker.postMessage(input);
}
function operationLabel(op) {
  if (!op) return "Before the first operation.";
  return op.kind === "flush"
    ? `Core ${op.core} flushes its modified blocks.`
    : op.kind === "read"
      ? `Core ${op.core} reads word ${op.address}.`
      : `Core ${op.core} writes ${op.value} to word ${op.address}.`;
}
function render() {
  const step = Number($("step").value),
    snap = result.snapshots[step],
    state = snap.state,
    input = result.input;
  $("step-count").textContent = `${step} / ${input.operations.length}`;
  $("operation-title").textContent = operationLabel(snap.operation);
  $("previous").disabled = step === 0;
  $("next").disabled = step === input.operations.length;
  $("undo").disabled = !history.length;
  $("play").disabled = !input.operations.length;
  $("append").textContent =
    step < input.operations.length ? "Branch + append" : "Append operation";
  $("branch-note").textContent =
    step < input.operations.length
      ? `Appending here keeps the first ${step} operations and replaces the future. Undo edit restores the previous scenario.`
      : "Append to the current trace. Undo edit restores the previous scenario (up to 30 edits).";
  $("caches").style.setProperty("--cores", input.cores);
  $("caches").replaceChildren(
    ...state.caches.map((cache, core) => {
      const card = el("article", undefined, "cache");
      card.append(
        el("h3", `Core ${core} / ${input.lines} direct-mapped slots`),
      );
      const wrap = el("div", undefined, "scroll"),
        table = el("table"),
        head = el("tr");
      head.append(
        ...["Slot", "Block", "Words", "MESI"].map((x) => el("th", x)),
      );
      const thead = el("thead");
      thead.append(head);
      table.append(thead);
      const body = el("tbody");
      cache.forEach((line, slot) => {
        const row = el("tr");
        if (snap.events.some((e) => e.core === core && e.block === line.block))
          row.className = "changed";
        row.append(
          el("td", String(slot)),
          el("td", line.block === null ? "—" : String(line.block)),
          el("td", line.state === "I" ? "—" : line.values.join(", ")),
        );
        const cell = el("td");
        cell.append(el("span", line.state, `badge ${line.state}`));
        row.append(cell);
        body.append(row);
      });
      table.append(body);
      wrap.append(table);
      card.append(wrap);
      return card;
    }),
  );
  let stale = 0;
  $("memory").replaceChildren(
    ...state.memory.map((value, address) => {
      const block = Math.floor(address / input.words),
        owner = state.caches.findIndex((cache) =>
          cache.some((l) => l.state === "M" && l.block === block),
        );
      const latest =
        owner < 0
          ? value
          : state.caches[owner].find(
              (l) => l.state === "M" && l.block === block,
            ).values[address % input.words];
      const old = value !== latest;
      if (old) stale++;
      const word = el("div", undefined, `word${old ? " stale" : ""}`);
      word.append(
        el("small", `WORD ${address} / B${block}`),
        el("strong", String(value)),
        el(
          "span",
          old
            ? `Latest ${latest} in C${owner}`
            : owner >= 0
              ? `Modified owner C${owner}`
              : "Memory current",
        ),
      );
      return word;
    }),
  );
  $("memory-note").textContent =
    `${stale} stale memory words · modified cache owners hold the current values`;
  $("events").replaceChildren(
    ...snap.events.map((event, i) => {
      const row = el("div", undefined, "event"),
        title = el("strong", `${i + 1}. ${event.type}`),
        detail = el("div");
      title.append(
        el(
          "small",
          `C${event.core}${event.block === null ? "" : ` / block ${event.block}`}${event.from && event.to ? ` / ${event.from} → ${event.to}` : ""}`,
        ),
      );
      detail.append(el("p", event.detail));
      row.append(title, detail);
      return row;
    }),
  );
  if (!snap.events.length)
    $("events").append(
      el(
        "p",
        "All caches are invalid. Memory contains the initial word values.",
        "hint",
      ),
    );
  const labels = {
    reads: "Processor reads",
    writes: "Processor writes",
    hits: "Cache hits",
    misses: "Cache misses",
    BusRd: "BusRd requests",
    BusRdX: "BusRdX requests",
    BusUpgr: "BusUpgr requests",
    writebacks: "Block writebacks",
    invalidations: "Copies invalidated",
    evictions: "Conflict evictions",
    silentUpgrades: "Silent E → M",
  };
  $("stats").replaceChildren(
    ...Object.entries(state.stats).map(([key, value]) => {
      const block = el("div");
      block.append(el("strong", String(value)), el("span", labels[key]));
      return block;
    }),
  );
}
function changeKind() {
  const kind = $("kind").value;
  $("address-label").hidden = kind === "flush";
  $("address").disabled = kind === "flush";
  $("value-label").hidden = kind !== "write";
  $("value").disabled = kind !== "write";
}
function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = el("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("config-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run({
    ...result.input,
    cores: Number($("cores").value),
    lines: Number($("lines").value),
    words: Number($("words").value),
  });
});
$("example").addEventListener("click", () => run(example, true, 0));
$("clear").addEventListener("click", () =>
  run({ ...result.input, operations: [] }, true, 0),
);
$("operation-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const kind = $("kind").value,
    op = { kind, core: Number($("core").value) };
  if (kind !== "flush") op.address = Number($("address").value);
  if (kind === "write") op.value = Number($("value").value);
  run({
    ...result.input,
    operations: [
      ...result.input.operations.slice(0, Number($("step").value)),
      op,
    ],
  });
});
$("undo").addEventListener("click", () => {
  if (history.length) run(history.pop(), false);
});
$("kind").addEventListener("change", changeKind);
$("step").addEventListener("input", () => {
  stop();
  render();
});
$("previous").addEventListener("click", () => {
  stop();
  $("step").value = Number($("step").value) - 1;
  render();
});
$("next").addEventListener("click", () => {
  stop();
  $("step").value = Number($("step").value) + 1;
  render();
});
$("play").addEventListener("click", () => {
  if (timer) {
    stop();
    return;
  }
  if (Number($("step").value) === result.input.operations.length)
    $("step").value = 0;
  $("play").textContent = "Pause";
  timer = setInterval(() => {
    const next = Number($("step").value) + 1;
    $("step").value = next;
    render();
    if (next >= result.input.operations.length) stop();
  }, 700);
});
$("apply").addEventListener("click", () => {
  try {
    run(JSON.parse($("json").value));
  } catch (error) {
    $("status").textContent = error.message;
  }
});
$("save").addEventListener("click", () =>
  download(
    "coherence-scenario.json",
    JSON.stringify(result.input, null, 2) + "\n",
  ),
);
$("export").addEventListener("click", () =>
  download(
    "coherence-evidence.json",
    JSON.stringify(
      {
        format: "coherence-choir-evidence-v1",
        ...result,
        inspectedStep: Number($("step").value),
      },
      null,
      2,
    ) + "\n",
  ),
);
$("csv").addEventListener("click", () => {
  const rows = [
    "step,kind,core,address,value,result,hit,bus_rd,bus_rdx,bus_upgrade,writebacks,invalidations",
    ...result.snapshots
      .slice(1)
      .map((s, i) =>
        [
          i + 1,
          s.operation.kind,
          s.operation.core,
          s.operation.address ?? "",
          s.operation.value ?? "",
          s.result ?? "",
          s.hit ?? "",
          s.state.stats.BusRd,
          s.state.stats.BusRdX,
          s.state.stats.BusUpgr,
          s.state.stats.writebacks,
          s.state.stats.invalidations,
        ].join(","),
      ),
  ];
  download("coherence-operations.csv", rows.join("\n") + "\n", "text/csv");
});
$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  try {
    if (!file) return;
    if (file.size > 50000) throw Error("Scenario files must be at most 50 KB.");
    run(JSON.parse(await file.text()));
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("file").value = "";
  }
});
changeKind();
run(example, false, 0);

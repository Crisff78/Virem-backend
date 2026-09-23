const { setTimeout: delay } = require("node:timers/promises");
function syntheticProvider(options = {}) {
  const calls = { answer: 0, extract: 0, transcribe: 0, inputs: [] };
  return {
    calls,
    available() {},
    async extract({ signal, pages }) {
      calls.extract++;
      await delay(options.delay || 20, undefined, { signal });
      return (
        options.extraction || {
          kind: "written_report",
          text:
            pages.filter(Boolean).join("\n") ||
            "Informe sintético para probar la interfaz.",
          findings: [],
          limitations: [
            "Documento de prueba; no constituye una lectura clínica real.",
          ],
        }
      );
    },
    async answer(input) {
      calls.answer++;
      calls.inputs.push(input);
      const summary = input.documents.length
        ? "Demostración: recibí tu informe sintético. Los datos extraídos aparecen separados de esta explicación de prueba."
        : "Demostración: recibí tu pregunta. Puedes contarme qué término deseas entender o qué te gustaría preparar para tu consulta.";
      for (let n = 20; n < summary.length + 20; n += 20) {
        await delay(options.delay || 20, undefined, { signal: input.signal });
        await input.onSummary(summary.slice(0, n));
      }
      if (options.fail) throw new Error("SYNTHETIC_SECRET_PROVIDER_ERROR");
      return {
        summary,
        interpretation:
          "Este texto solo permite probar la navegación y los detalles desplegables. No interpreta información médica.",
        uncertainty:
          "La conexión con OpenAI no está activa en esta vista previa.",
        consultation: ["¿Qué información conviene llevar a mi consulta?"],
        followups: ["Explícamelo más sencillo", "Preparar mis preguntas"],
      };
    },
    async transcribe() {
      calls.transcribe++;
      return "Dictado sintético para revisar antes de enviar.";
    },
  };
}
module.exports = { syntheticProvider };

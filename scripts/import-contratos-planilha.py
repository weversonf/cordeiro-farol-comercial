import json
import re
from datetime import date, datetime
from pathlib import Path
import openpyxl

DEFAULT_XLSX = Path(
    r"C:\Users\weverson.feitosa\Downloads\Planilha Gestão de Contratos - Contratos a serem renovados 180 dias.xlsx"
)
OUT_JSON = Path(__file__).resolve().parent.parent / "data" / "contratos-planilha.json"

UNIT_MAP = {
    "unid_clcp": "Centro Logístico",
    "unid_pecem": "Pecém",
    "unid_eng": "Engenharia",
    "unid_trans": "Transportes",
    "transportes": "Transportes",
    "wind": "Wind",
    "norte": "Norte",
}


def clean_str(val):
    if val is None:
        return ""
    s = str(val).replace("_x000D_", " ").replace("\r", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_date(val):
    if isinstance(val, datetime):
        return val.date().isoformat()
    if isinstance(val, date):
        return val.isoformat()
    s = clean_str(val)
    if not s or s in ("-", "—"):
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:10], fmt).date().isoformat()
        except ValueError:
            pass
    return None


def normalize_unit(val):
    raw = clean_str(val)
    if not raw:
        return "Não informado"
    return UNIT_MAP.get(raw.lower(), raw)


def main():
    wb = openpyxl.load_workbook(DEFAULT_XLSX, read_only=True, data_only=True)
    ws = wb["PGC-CONSOLIDADA"]

    ref_date = None
    contratos = []

    for i, row in enumerate(ws.iter_rows(max_col=26, values_only=True), 1):
        row = list(row) + [None] * max(0, 26 - len(row))
        if i == 1:
            ref_date = parse_date(row[23])
            continue
        if not any(row):
            continue

        status = clean_str(row[11])
        if status.lower() != "em andamento":
            continue

        num_seq = clean_str(row[0])
        num_contrato = clean_str(row[4])
        cliente = clean_str(row[3])
        if not cliente and not num_contrato:
            continue

        equipamentos = clean_str(row[5])
        observacao = clean_str(row[22])
        consultor = clean_str(row[1]) or "Sem consultor"
        unidade = normalize_unit(row[2])
        tipo_contrato = clean_str(row[10]) or "Não informado"
        contrato_assinado = clean_str(row[9]) or None
        indice_reajuste = clean_str(row[21]) or None

        dt_inicio = parse_date(row[12]) or parse_date(row[13])
        dt_fim = parse_date(row[18]) or parse_date(row[16]) or parse_date(row[14])

        titulo = equipamentos or observacao or f"Contrato {num_contrato or num_seq}"
        if len(titulo) > 120:
            titulo = titulo[:117].rstrip() + "..."

        contratos.append(
            {
                "id": num_contrato or num_seq or str(i),
                "numeroSeq": num_seq or None,
                "titulo": titulo,
                "cliente": cliente or "Cliente não informado",
                "consultor": consultor,
                "unidade": unidade,
                "tipoContrato": tipo_contrato,
                "contratoAssinado": contrato_assinado,
                "indiceReajuste": indice_reajuste,
                "observacao": observacao or None,
                "etapa": status,
                "equipamentos": equipamentos,
                "valor": 0,
                "dataInicio": dt_inicio,
                "dataFim": dt_fim,
            }
        )

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "fonte": "Planilha Gestão de Contratos - Contratos a serem renovados 180 dias.xlsx (PGC-CONSOLIDADA)",
        "dataReferenciaPlanilha": ref_date,
        "importadoEm": datetime.now().isoformat(timespec="seconds"),
        "totalRegistros": len(contratos),
        "contratos": contratos,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exportados {len(contratos)} contratos ativos para {OUT_JSON}")


if __name__ == "__main__":
    main()

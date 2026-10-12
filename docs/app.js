/* Arena das IAs — lê docs/data/*.json e desenha o placar, a corrida e o feed. */
(function () {
  "use strict";

  var SP = "America/Sao_Paulo";
  var $ = function (id) { return document.getElementById(id); };

  function brl(v) {
    return "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function brl0(v) {
    return "R$ " + Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }
  function pct(v) {
    var s = Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v > 0 ? "+" : "") + s + "%";
  }
  function hora(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: SP });
  }
  function diaHora(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: SP }) + " às " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: SP });
  }
  function el(tag, cls, texto) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function carregar(nome) {
    return fetch("data/" + nome + "?v=" + Math.floor(Date.now() / 60000), { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error(nome + " " + r.status); return r.json(); });
  }

  /* ---------- placar ---------- */
  function pulso(estado) {
    var p = $("pulso");
    p.className = "pulso";
    if (!estado.atualizado_em) {
      p.textContent = "A arena ainda não rodou a primeira rodada.";
      return;
    }
    var idade = (Date.now() - new Date(estado.atualizado_em).getTime()) / 60000;
    var t = estado.temporada || {};
    var partes = [];
    if (idade <= 75) {
      p.classList.add("vivo");
      partes.push("Ao vivo. Última rodada às " + hora(estado.atualizado_em) + ".");
      if (estado.proxima_rodada_estimada) partes.push("Próxima por volta das " + hora(estado.proxima_rodada_estimada) + ".");
    } else {
      p.classList.add("parado");
      partes.push("Última rodada em " + diaHora(estado.atualizado_em) + ". A arena está parada desde então.");
    }
    if (t.status === "em_andamento" && t.inicio) {
      var dias = Math.max(1, Math.round((Date.now() - new Date(t.inicio).getTime()) / 86400000));
      partes.push("Dia " + dias + " de 14 da temporada.");
    } else if (t.status === "encerrada") {
      partes.push("Temporada encerrada.");
    } else if (t.status === "aguardando") {
      partes.push("A temporada começa quando a primeira IA entrar.");
    }
    p.textContent = partes.join(" ");
  }

  function placar(estado) {
    var ol = $("ranking");
    ol.innerHTML = "";
    var agentes = estado.agentes || [];
    var dentro = agentes.filter(function (a) { return a.status !== "sem_chave"; });
    var fora = agentes.filter(function (a) { return a.status === "sem_chave"; });
    dentro.sort(function (a, b) { return b.patrimonio - a.patrimonio; });
    var pos = 0;

    dentro.forEach(function (a) {
      pos += 1;
      var li = el("li", "linha" + (pos === 1 ? " lider" : ""));
      li.style.setProperty("--cor", a.cor);
      li.appendChild(el("span", "pos", String(pos)));
      li.appendChild(el("span", "barra"));
      var nome = el("div", "nome");
      nome.appendChild(el("b", null, a.nome));
      nome.appendChild(el("span", null, a.empresa));
      if (a.status === "limite") nome.appendChild(el("span", "tag", "cota grátis do dia acabou, ficou parada"));
      else if (a.status === "erro") nome.appendChild(el("span", "tag ruim", "sem resposta na última rodada"));
      li.appendChild(nome);
      li.appendChild(el("span", "patrimonio", brl(a.patrimonio)));
      var r = a.retorno_pct || 0;
      li.appendChild(el("span", "retorno " + (r > 0.005 ? "up" : r < -0.005 ? "down" : "zero"), pct(r)));
      ol.appendChild(li);
    });

    fora.forEach(function (a) {
      var li = el("li", "linha fora");
      li.style.setProperty("--cor", a.cor);
      li.appendChild(el("span", "pos", "–"));
      li.appendChild(el("span", "barra"));
      var nome = el("div", "nome");
      nome.appendChild(el("b", null, a.nome));
      nome.appendChild(el("span", null, a.empresa));
      li.appendChild(nome);
      li.appendChild(el("span", "patrimonio", "ainda não entrou"));
      li.appendChild(el("span", "retorno zero", ""));
      ol.appendChild(li);
    });

    if (!agentes.length) {
      ol.appendChild(el("li", "linha fora", "Nenhuma IA cadastrada ainda."));
    }

    var h = $("hodl");
    if (estado.hodl && estado.hodl.patrimonio != null) {
      h.hidden = false;
      h.innerHTML = "";
      h.appendChild(document.createTextNode("Quem só comprou bitcoin no início e não mexeu mais teria "));
      h.appendChild(el("b", null, brl(estado.hodl.patrimonio) + " (" + pct(estado.hodl.retorno_pct) + ")"));
      h.appendChild(document.createTextNode(". É a régua que todas precisam bater."));
    } else {
      h.hidden = true;
    }
  }

  /* ---------- corrida (SVG) ---------- */
  function corrida(estado, historico) {
    var box = $("grafico");
    box.innerHTML = "";
    var agentes = (estado.agentes || []).filter(function (a) { return a.status !== "sem_chave"; });
    var pontos = (historico || []).filter(function (h) { return h.e && Object.keys(h.e).length; });
    if (pontos.length < 2 || !agentes.length) {
      box.appendChild(el("p", "vazio", "A corrida aparece aqui depois das primeiras rodadas."));
      return;
    }
    var W = 1000, H = 380, padL = 76, padR = 18, padT = 16, padB = 34;
    var t0 = new Date(pontos[0].t).getTime(), t1 = new Date(pontos[pontos.length - 1].t).getTime();
    if (t1 === t0) t1 = t0 + 1;
    var vals = [];
    pontos.forEach(function (p) {
      Object.keys(p.e).forEach(function (k) { vals.push(p.e[k]); });
      if (p.hodl != null) vals.push(p.hodl);
    });
    var cap = (estado.temporada && estado.temporada.capital_inicial) || 10000;
    vals.push(cap);
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    var folga = Math.max((vmax - vmin) * 0.08, cap * 0.004);
    vmin -= folga; vmax += folga;
    var x = function (t) { return padL + (t - t0) / (t1 - t0) * (W - padL - padR); };
    var y = function (v) { return padT + (vmax - v) / (vmax - vmin) * (H - padT - padB); };

    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Gráfico do patrimônio de cada IA ao longo da temporada");

    // grade: 4 linhas horizontais com valor em reais
    for (var i = 0; i <= 4; i++) {
      var v = vmin + (vmax - vmin) * i / 4;
      var ln = document.createElementNS(ns, "line");
      ln.setAttribute("x1", padL); ln.setAttribute("x2", W - padR);
      ln.setAttribute("y1", y(v)); ln.setAttribute("y2", y(v));
      ln.setAttribute("class", "grade");
      svg.appendChild(ln);
      var tx = document.createElementNS(ns, "text");
      tx.setAttribute("x", padL - 8); tx.setAttribute("y", y(v) + 4);
      tx.setAttribute("text-anchor", "end"); tx.setAttribute("class", "eixo");
      tx.textContent = brl0(v);
      svg.appendChild(tx);
    }
    // linha do capital inicial
    var base = document.createElementNS(ns, "line");
    base.setAttribute("x1", padL); base.setAttribute("x2", W - padR);
    base.setAttribute("y1", y(cap)); base.setAttribute("y2", y(cap));
    base.setAttribute("stroke", "rgba(243,235,220,0.35)"); base.setAttribute("stroke-width", "1");
    svg.appendChild(base);

    // eixo x: início e fim
    [[pontos[0].t, "start"], [pontos[pontos.length - 1].t, "end"]].forEach(function (par) {
      var tx = document.createElementNS(ns, "text");
      tx.setAttribute("x", x(new Date(par[0]).getTime())); tx.setAttribute("y", H - 10);
      tx.setAttribute("text-anchor", par[1]); tx.setAttribute("class", "eixo");
      tx.textContent = diaHora(par[0]);
      svg.appendChild(tx);
    });

    function caminho(serie) {
      var d = "";
      serie.forEach(function (p, i) { d += (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1); });
      return d;
    }
    // HODL tracejado
    var hodl = pontos.filter(function (p) { return p.hodl != null; }).map(function (p) { return [new Date(p.t).getTime(), p.hodl]; });
    if (hodl.length > 1) {
      var ph = document.createElementNS(ns, "path");
      ph.setAttribute("d", caminho(hodl));
      ph.setAttribute("fill", "none"); ph.setAttribute("stroke", "rgba(243,235,220,0.7)");
      ph.setAttribute("stroke-width", "2"); ph.setAttribute("stroke-dasharray", "5 6");
      svg.appendChild(ph);
    }
    agentes.forEach(function (a) {
      var serie = pontos.filter(function (p) { return p.e[a.id] != null; }).map(function (p) { return [new Date(p.t).getTime(), p.e[a.id]]; });
      if (serie.length < 2) return;
      var pa = document.createElementNS(ns, "path");
      pa.setAttribute("d", caminho(serie));
      pa.setAttribute("fill", "none"); pa.setAttribute("stroke", a.cor);
      pa.setAttribute("stroke-width", "3"); pa.setAttribute("stroke-linejoin", "round"); pa.setAttribute("stroke-linecap", "round");
      svg.appendChild(pa);
      var ult = serie[serie.length - 1];
      var c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", x(ult[0])); c.setAttribute("cy", y(ult[1])); c.setAttribute("r", "5"); c.setAttribute("fill", a.cor);
      svg.appendChild(c);
    });
    box.appendChild(svg);

    var leg = el("div", "legenda");
    agentes.forEach(function (a) {
      var s = el("span");
      var i = el("i"); i.style.setProperty("--cor", a.cor);
      s.appendChild(i); s.appendChild(document.createTextNode(a.nome));
      leg.appendChild(s);
    });
    if (hodl.length > 1) {
      var s2 = el("span");
      s2.appendChild(el("i", "tracejada")); s2.appendChild(document.createTextNode("comprou bitcoin e ficou quieto"));
      leg.appendChild(s2);
    }
    box.appendChild(leg);
  }

  /* ---------- feed ---------- */
  function fraseAcao(d) {
    var fr = Math.round((d.fracao || 0) * 100);
    if (d.erro) return "Não respondeu nesta rodada.";
    if (d.acao === "manter") return "Ficou parada.";
    if (d.executada === false) {
      return (d.acao === "comprar" ? "Tentou comprar " : "Tentou vender ") + (d.ativo || "") + ", mas " + (d.motivo || "não deu") + ".";
    }
    if (d.acao === "comprar") {
      return "Comprou " + brl(d.valor) + " de " + d.ativo + (d.preco ? " a " + brl0(d.preco) : "") + (fr >= 99 ? ", tudo que tinha em caixa." : " (" + fr + "% do caixa).");
    }
    return "Vendeu " + (fr >= 99 ? "toda a posição em " : fr + "% da posição em ") + d.ativo + " por " + brl(d.valor) + (d.preco ? " a " + brl0(d.preco) : "") + ".";
  }

  function feed(estado, decisoes) {
    var ol = $("feed");
    ol.innerHTML = "";
    var cores = {};
    (estado.agentes || []).forEach(function (a) { cores[a.id] = a.cor; });
    var lista = (decisoes || []).slice(-40).reverse();
    $("feed-vazio").hidden = lista.length > 0;
    lista.forEach(function (d) {
      var li = el("li", "item");
      li.style.setProperty("--cor", cores[d.agente] || "#999");
      li.appendChild(el("span", "fio"));
      var corpo = el("div");
      var cab = el("div", "cab");
      cab.appendChild(el("span", "quem", d.nome));
      cab.appendChild(el("span", "quando", diaHora(d.t)));
      corpo.appendChild(cab);
      var acao = el("p", "acao" + (d.acao === "manter" || d.executada === false || d.erro ? " nao" : ""), fraseAcao(d));
      corpo.appendChild(acao);
      if (d.raciocinio && !d.erro) corpo.appendChild(el("p", "fala", d.raciocinio));
      li.appendChild(corpo);
      ol.appendChild(li);
    });
  }

  /* ---------- corretoras ---------- */
  function corretoras(links) {
    var ul = $("links-corretoras");
    ul.innerHTML = "";
    (links || []).forEach(function (l) {
      var li = el("li");
      var a = el("a", null, l.nome);
      a.href = l.url; a.rel = l.afiliado ? "sponsored noopener" : "noopener"; a.target = "_blank";
      li.appendChild(a);
      li.appendChild(el("span", null, l.nota));
      ul.appendChild(li);
    });
  }

  /* ---------- carga ---------- */
  function tudo() {
    Promise.all([carregar("state.json"), carregar("historico.json").catch(function () { return []; }), carregar("decisoes.json").catch(function () { return []; })])
      .then(function (r) {
        var estado = r[0];
        pulso(estado);
        placar(estado);
        corrida(estado, r[1]);
        feed(estado, r[2]);
      })
      .catch(function (e) {
        $("pulso").textContent = "Não consegui carregar o placar agora. Tente de novo em um minuto.";
        $("pulso").className = "pulso parado";
        console.error(e);
      });
    carregar("links.json").then(corretoras).catch(function () {});
  }
  tudo();
  setInterval(tudo, 5 * 60 * 1000);
})();

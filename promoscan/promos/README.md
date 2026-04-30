# Struttura cartella promos/

Per ogni promozione, crea una sottocartella con il PromoID come nome:

```
promos/
├── 13498/
│   ├── keyvisual.jpg   ← immagine key visual (JPG o PNG, max 1MB)
│   └── tc.txt          ← testo T&C convertito da PDF/PPT
├── 13537/
│   ├── keyvisual.jpg
│   └── tc.txt
└── ...
```

## Come convertire PDF/PPT in tc.txt

Apri il documento, seleziona tutto il testo (Ctrl+A), copialo e incollalo
in un file di testo (.txt) salvato come UTF-8. Rinominalo `tc.txt`.

## Note

- Il key visual non trovato mostra automaticamente un placeholder nell'app
- Il T&C non trovato non blocca l'app: l'AI risponde con i soli dati del CSV
- I nomi delle cartelle devono corrispondere esattamente al PromoID nel CSV

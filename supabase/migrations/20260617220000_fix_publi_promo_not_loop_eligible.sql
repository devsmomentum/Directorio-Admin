-- Los planes PUBLI_PROMO no forman parte del loop publicitario de video.
-- loop_eligible controla si el plan aparece en /panel/configuracion → Slots por plan
-- y si sus campañas cuentan contra el cap del loop para aliados.
UPDATE public.plans
SET loop_eligible = false,
    max_brands    = NULL
WHERE plan_key IN ('PUBLI_PROMO_DIARIO', 'PUBLI_PROMO_SEMANAL', 'PUBLI_PROMO');

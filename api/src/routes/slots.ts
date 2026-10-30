import { Router } from 'express';
import { getSlotById, listSlots } from '../services/slots.js';

export const slotsRouter = Router();

slotsRouter.get('/', async (req, res, next) => {
  try {
    const provider = req.query.provider as string | undefined;
    const onlyAvailable = req.query.available === 'true';
    const slots = await listSlots(provider, onlyAvailable);
    res.status(200).json({
      slots,
      data: slots,
      count: slots.length,
    });
  } catch (err) {
    next(err);
  }
});

slotsRouter.get('/:id', async (req, res, next) => {
  try {
    const slot = await getSlotById(req.params.id);
    res.status(200).json({
      slot,
      ...slot,
    });
  } catch (err) {
    next(err);
  }
});
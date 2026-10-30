import { Router } from 'express';
import { getSlotById, listSlots } from '../services/slots.js';

export const slotsRouter = Router();

slotsRouter.get('/', async (req, res, next) => {
  try {
    const showAll = req.query.all === 'true' || req.query.available === 'false';
    const slots = await listSlots(!showAll);
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